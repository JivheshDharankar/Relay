import { WorkflowStage } from '../../orchestration/types';
import { ModelProvider, ModelProviderError, getModelProvider } from '../model';
import { IntentExtractor, ValidatedIntent } from '../intent/intentExtractor';
import {
  DiscoveryPlanner,
  ValidatedDiscoveryPlan,
  buildDiscoveryQueries,
} from '../discovery/discoveryPlanner';
import {
  QuoteInterpreter,
  QuoteInterpretInput,
  ValidatedQuoteInterpretation,
  InterpretedResponseLines,
  interpretationToResponseLines,
} from '../quote/quoteInterpreter';
import {
  NegotiationStrategist,
  StrategyContext,
  ValidatedStrategy,
  StrategyConversion,
  strategyToProposalInput,
} from '../negotiation/negotiationStrategist';
import {
  OrchestrationPlanner,
  RoutingContext,
  ValidatedRoutingDecision,
  ResolvedRoute,
  resolveRoute,
} from '../orchestration/orchestrationPlanner';
import {
  SupplierDiscoveryProvider,
  getSupplierDiscoveryProvider,
} from '../../discovery/supplier';
import {
  SupplierCandidate,
  SupplierDiscoveryCoordinates,
  SupplierDiscoveryQuery,
} from '../../discovery/supplier/types';
import {
  AdapterFailure,
  AdapterFailureCode,
  AdapterResult,
  StageEvidence,
} from './types';

const RETRYABLE_PROVIDER_CODES = new Set([
  'META_TIMEOUT',
  'META_RATE_LIMITED',
  'META_SERVER_ERROR',
  'META_NETWORK_ERROR',
]);

function providerFailure(
  stage: WorkflowStage,
  code: string,
  message: string
): AdapterFailure {
  let mapped: AdapterFailureCode = 'PROVIDER_ERROR';
  if (code === 'META_TIMEOUT') mapped = 'MODEL_TIMEOUT';
  else if (code === 'META_MALFORMED_RESPONSE') mapped = 'MALFORMED_RESPONSE';
  return {
    code: mapped,
    message,
    stage,
    retryable: RETRYABLE_PROVIDER_CODES.has(code),
    underlyingCode: code,
  };
}

function crashFailure(stage: WorkflowStage, err: unknown): AdapterFailure {
  return {
    code: 'ADAPTER_ERROR',
    message: err instanceof Error ? err.message : String(err),
    stage,
    retryable: false,
  };
}

function evidence(
  stage: WorkflowStage,
  capability: string,
  summary: string,
  details: Record<string, unknown>
): StageEvidence {
  return { stage, capability, summary, details };
}

/**
 * Phase 16 — AI execution adapter.
 *
 * Thin, additive seam between the deterministic workflow engine and the
 * Phase 14/15 AI modules. Each method: takes authoritative context, invokes
 * exactly one AI capability, returns the validated result with audit
 * evidence — or a typed FAIL_CLOSED failure. The adapter holds no workflow
 * state, mutates nothing, and never reimplements engine logic.
 */
export class AIWorkflowAdapter {
  private provider: ModelProvider;
  private discoveryProvider: SupplierDiscoveryProvider | undefined;

  constructor(options?: {
    provider?: ModelProvider;
    discoveryProvider?: SupplierDiscoveryProvider;
  }) {
    this.provider = options?.provider ?? getModelProvider();
    this.discoveryProvider = options?.discoveryProvider;
  }

  public async understandIntent(requestText: string): Promise<AdapterResult<ValidatedIntent>> {
    const stage: WorkflowStage = 'UNDERSTAND';
    try {
      const result = await new IntentExtractor({ provider: this.provider }).extract(requestText);
      if (result.status === 'error') {
        const issue = result.issues[0] ?? { code: 'PROVIDER_ERROR', message: 'Unknown error.' };
        return { ok: false, failure: providerFailure(stage, issue.code, issue.message) };
      }
      if (result.status === 'invalid') {
        const issue = result.issues[0] ?? { code: 'SCHEMA_VIOLATION', message: 'Invalid intent.' };
        return {
          ok: false,
          failure: {
            code: 'VALIDATION_FAILED',
            message: issue.message,
            stage,
            retryable: false,
            underlyingCode: issue.code,
          },
        };
      }
      if (result.status === 'unresolved' || !result.intent) {
        const reasons = result.issues.map((i) => i.code).join(', ') || 'UNRESOLVED_INTENT';
        return {
          ok: false,
          failure: {
            code: 'UNMAPPABLE_PRODUCT',
            message: `Intent could not be fully resolved: ${reasons}.`,
            stage,
            retryable: false,
          },
        };
      }
      const intent = result.intent;
      return {
        ok: true,
        value: intent,
        evidence: evidence('UNDERSTAND', 'intent-extractor', `Resolved ${intent.items.length} items.`, {
          itemCount: intent.items.length,
          products: intent.items.map((i) =>
            i.resolution.status === 'resolved' ? i.resolution.canonicalName : i.productName
          ),
          quantities: intent.items.map((i) => i.quantity),
          units: intent.items.map((i) => i.unit),
          deadlineHours: intent.deadline?.maxHours,
        }),
      };
    } catch (err) {
      if (err instanceof ModelProviderError) {
        return { ok: false, failure: providerFailure(stage, err.code, err.message) };
      }
      return { ok: false, failure: crashFailure(stage, err) };
    }
  }

  public async routeNextAction(context: RoutingContext): Promise<
    AdapterResult<{ decision: ValidatedRoutingDecision; route: ResolvedRoute }>
  > {
    const stage = context.currentStage;
    try {
      const result = await new OrchestrationPlanner({ provider: this.provider }).planNextAction(
        context
      );
      if (result.status === 'error') {
        const issue = result.issues[0] ?? { code: 'PROVIDER_ERROR', message: 'Unknown error.' };
        return { ok: false, failure: providerFailure(stage, issue.code, issue.message) };
      }
      if (result.status === 'invalid' || !result.decision) {
        const issue = result.issues[0] ?? { code: 'SCHEMA_VIOLATION', message: 'Invalid decision.' };
        return {
          ok: false,
          failure: {
            code: issue.code === 'NO_TOOL_CALL' ? 'NO_TOOL_CALL' : 'VALIDATION_FAILED',
            message: issue.message,
            stage,
            retryable: false,
            underlyingCode: issue.code,
          },
        };
      }
      const route = resolveRoute(result.decision.action);
      return {
        ok: true,
        value: { decision: result.decision, route },
        evidence: evidence(stage, 'orchestration-planner', `Routed to ${result.decision.action}.`, {
          action: result.decision.action,
          targetStage: result.decision.targetStage,
          capability: route.route.capability,
        }),
      };
    } catch (err) {
      if (err instanceof ModelProviderError) {
        return { ok: false, failure: providerFailure(stage, err.code, err.message) };
      }
      return { ok: false, failure: crashFailure(stage, err) };
    }
  }

  public async planDiscovery(intent: ValidatedIntent): Promise<AdapterResult<ValidatedDiscoveryPlan>> {
    const stage: WorkflowStage = 'DISCOVER';
    try {
      const result = await new DiscoveryPlanner({ provider: this.provider }).plan(intent);
      if (result.status === 'error') {
        const issue = result.issues[0] ?? { code: 'PROVIDER_ERROR', message: 'Unknown error.' };
        return { ok: false, failure: providerFailure(stage, issue.code, issue.message) };
      }
      if (result.status === 'invalid' || !result.plan) {
        const issue = result.issues[0] ?? { code: 'SCHEMA_VIOLATION', message: 'Invalid plan.' };
        return {
          ok: false,
          failure: {
            code: issue.code === 'NO_TOOL_CALL' ? 'NO_TOOL_CALL' : 'VALIDATION_FAILED',
            message: issue.message,
            stage,
            retryable: false,
            underlyingCode: issue.code,
          },
        };
      }
      return {
        ok: true,
        value: result.plan,
        evidence: evidence(stage, 'discovery-planner', `Planned discovery for ${result.plan.items.length} items.`, {
          itemCount: result.plan.items.length,
          radiusKm: result.plan.geography.radiusKm,
          maxHours: result.plan.fulfillment?.maxHours,
        }),
      };
    } catch (err) {
      if (err instanceof ModelProviderError) {
        return { ok: false, failure: providerFailure(stage, err.code, err.message) };
      }
      return { ok: false, failure: crashFailure(stage, err) };
    }
  }

  public async discoverSuppliers(
    plan: ValidatedDiscoveryPlan,
    coordinates: SupplierDiscoveryCoordinates,
    limit?: number
  ): Promise<
    AdapterResult<{ queries: SupplierDiscoveryQuery[]; candidatesByItem: SupplierCandidate[][] }>
  > {
    const stage: WorkflowStage = 'DISCOVER';
    try {
      const queries = buildDiscoveryQueries(plan, { coordinates, limit });
      const provider = this.discoveryProvider ?? getSupplierDiscoveryProvider();
      const candidatesByItem: SupplierCandidate[][] = [];
      for (const query of queries) {
        candidatesByItem.push(await provider.discoverSuppliers(query));
      }
      const emptyIndex = candidatesByItem.findIndex((list) => list.length === 0);
      if (emptyIndex >= 0) {
        return {
          ok: false,
          failure: {
            code: 'NO_CANDIDATES',
            message: `No suppliers discovered for plan item ${emptyIndex}.`,
            stage,
            retryable: false,
          },
        };
      }
      return {
        ok: true,
        value: { queries, candidatesByItem },
        evidence: evidence(
          stage,
          `supplier-discovery:${provider.providerName}`,
          `Discovered suppliers for ${queries.length} items.`,
          {
            itemCount: queries.length,
            candidateCounts: candidatesByItem.map((list) => list.length),
            provider: provider.providerName,
          }
        ),
      };
    } catch (err) {
      if (err instanceof ModelProviderError) {
        return { ok: false, failure: providerFailure(stage, err.code, err.message) };
      }
      const code =
        err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : '';
      const retryable = code === 'REQUEST_TIMEOUT' || code === 'RATE_LIMIT_EXCEEDED';
      return {
        ok: false,
        failure: {
          code: 'DISCOVERY_FAILED',
          message: err instanceof Error ? err.message : String(err),
          stage,
          retryable,
          underlyingCode: code || undefined,
        },
      };
    }
  }

  public async interpretQuote(input: QuoteInterpretInput): Promise<
    AdapterResult<{ interpretation: ValidatedQuoteInterpretation; lines: InterpretedResponseLines }>
  > {
    const stage: WorkflowStage = 'QUOTE';
    try {
      const result = await new QuoteInterpreter({ provider: this.provider }).interpret(input);
      if (result.status === 'error') {
        const issue = result.issues[0] ?? { code: 'PROVIDER_ERROR', message: 'Unknown error.' };
        return { ok: false, failure: providerFailure(stage, issue.code, issue.message) };
      }
      if (result.status === 'invalid' || !result.interpretation) {
        const issue = result.issues[0] ?? { code: 'SCHEMA_VIOLATION', message: 'Invalid interpretation.' };
        return {
          ok: false,
          failure: {
            code: issue.code === 'NO_TOOL_CALL' ? 'NO_TOOL_CALL' : 'VALIDATION_FAILED',
            message: issue.message,
            stage,
            retryable: false,
            underlyingCode: issue.code,
          },
        };
      }
      const lines = interpretationToResponseLines(result.interpretation);
      if (lines.lineItems.length === 0) {
        return {
          ok: false,
          failure: {
            code: 'NO_USABLE_LINES',
            message: `No usable line items: ${lines.droppedItems.map((d) => d.reason).join(', ') || 'none extracted'}.`,
            stage,
            retryable: false,
          },
        };
      }
      return {
        ok: true,
        value: { interpretation: result.interpretation, lines },
        evidence: evidence(stage, 'quote-interpreter', `Interpreted ${lines.lineItems.length} line items.`, {
          lineCount: lines.lineItems.length,
          droppedCount: lines.droppedItems.length,
          deliveryEtaHours: lines.deliveryEtaHours,
          deliveryFee: lines.deliveryFee,
        }),
      };
    } catch (err) {
      if (err instanceof ModelProviderError) {
        return { ok: false, failure: providerFailure(stage, err.code, err.message) };
      }
      return { ok: false, failure: crashFailure(stage, err) };
    }
  }

  public async planNegotiation(context: StrategyContext): Promise<
    AdapterResult<{ strategy: ValidatedStrategy; conversion: StrategyConversion }>
  > {
    const stage: WorkflowStage = 'NEGOTIATE';
    try {
      const result = await new NegotiationStrategist({ provider: this.provider }).propose(context);
      if (result.status === 'error') {
        const issue = result.issues[0] ?? { code: 'PROVIDER_ERROR', message: 'Unknown error.' };
        return { ok: false, failure: providerFailure(stage, issue.code, issue.message) };
      }
      if (result.status === 'invalid' || !result.strategy) {
        const issue = result.issues[0] ?? { code: 'SCHEMA_VIOLATION', message: 'Invalid strategy.' };
        return {
          ok: false,
          failure: {
            code: issue.code === 'NO_TOOL_CALL' ? 'NO_TOOL_CALL' : 'VALIDATION_FAILED',
            message: issue.message,
            stage,
            retryable: false,
            underlyingCode: issue.code,
          },
        };
      }
      const conversion = strategyToProposalInput(result.strategy, context);
      return {
        ok: true,
        value: { strategy: result.strategy, conversion },
        evidence: evidence(stage, 'negotiation-strategist', `Strategy ${result.strategy.action}.`, {
          action: result.strategy.action,
          convertible: conversion.convertible,
          roundNumber: result.strategy.roundNumber,
        }),
      };
    } catch (err) {
      if (err instanceof ModelProviderError) {
        return { ok: false, failure: providerFailure(stage, err.code, err.message) };
      }
      return { ok: false, failure: crashFailure(stage, err) };
    }
  }
}
