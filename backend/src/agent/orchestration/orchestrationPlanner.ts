import { ZodError } from 'zod';
import { ModelProvider, ModelProviderError, getModelProvider } from '../model';
import {
  WorkflowStage,
  WorkflowStatus,
  RelayWorkflow,
} from '../../orchestration/types';
import { canTransitionWorkflowStage } from '../../orchestration/stateMachine';
import {
  ROUTING_ACTION_PRIORITY,
  CONTEXT_VOCABULARY,
  KNOWN_STAGES,
  ORCHESTRATION_ACTIONS,
  ORCHESTRATION_SYSTEM_PROMPT,
  ORCHESTRATION_TOOL_NAME,
  PLAN_NEXT_ACTION_TOOL,
  ROUTE_TABLE,
  STAY_ACTIONS,
  TERMINAL_STATUSES,
  CapabilityRoute,
  OrchestrationAction,
  RawRoutingDecision,
  rawDecisionSchema,
  screenRoutingText,
} from './orchestrationSchema';

export type RoutingStatus = 'ok' | 'invalid' | 'error';

/** Relay-owned verified routing context. The model echoes it; Relay checks it. */
export interface RoutingIntentSnapshot {
  status: 'resolved' | 'ambiguous' | 'unresolved' | 'missing';
  quantities: number[];
  units: string[];
  deadlineHours?: number;
}

export interface RoutingContext {
  workflowId: string;
  currentStage: WorkflowStage;
  workflowStatus: WorkflowStatus;
  intent: RoutingIntentSnapshot;
  suppliersDiscovered: number;
  suppliersQualified: number;
  quotesReceived: number;
  quotesInterpreted: number;
  rawResponsesPending: number;
  negotiationRound: number;
  negotiationMaxRounds: number;
  negotiationEligible: boolean;
  awaitingExternal: boolean;
  blockers: string[];
  communityQuantity?: number;
}

export interface ValidatedRoutingDecision {
  action: OrchestrationAction;
  currentStage: WorkflowStage;
  targetStage: WorkflowStage;
  priority: string;
  objective: string;
  rationale: string;
  itemCount: number;
  quantities: number[];
  units: string[];
  deadlineHours?: number;
  requiredCapabilities: string[];
  requiredContext: string[];
  constraintsAcknowledged: string[];
  stopConditions: string[];
}

export interface RoutingIssue {
  code: string;
  message: string;
}

export interface RoutingResult {
  status: RoutingStatus;
  decision?: ValidatedRoutingDecision;
  issues: RoutingIssue[];
}

export interface ResolvedRoute {
  action: OrchestrationAction;
  route: CapabilityRoute;
}

function mapZodIssues(error: ZodError): RoutingIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    if (issue.code === 'unrecognized_keys') {
      return {
        code: 'EXTRA_FIELD',
        message: `Routing decision contains unauthorized field(s) at ${path || 'root'}: ${issue.keys.join(', ')}`,
      };
    }
    return {
      code: 'SCHEMA_VIOLATION',
      message: `Routing decision failed validation at ${path || 'root'}: ${issue.message}`,
    };
  });
}

/**
 * Relay-owned capability router. Maps an allowlisted action to its existing
 * capability and stage. Controlled entirely by Relay; the model only selects
 * the semantic action. Routing never executes anything.
 */
export function resolveRoute(action: OrchestrationAction): ResolvedRoute {
  return { action, route: ROUTE_TABLE[action] };
}

function availabilityOf(context: RoutingContext): Record<string, boolean> {
  return {
    'verified-intent': context.intent.status === 'resolved',
    'resolved-products': context.intent.status === 'resolved',
    quantities: context.intent.quantities.length > 0,
    units: context.intent.units.length > 0,
    deadline: context.intent.deadlineHours !== undefined,
    'supplier-candidates': context.suppliersDiscovered > 0,
    'qualified-suppliers': context.suppliersQualified > 0,
    'received-quotes': context.quotesReceived > 0,
    'interpreted-quotes': context.quotesInterpreted > 0,
    'negotiation-state': true,
    'workflow-status': true,
    'policy-constraints': true,
    'community-demand': context.communityQuantity !== undefined,
  };
}

/**
 * Phase 15 — deterministic orchestration-routing service.
 *
 * Flow: Relay-owned verified workflow context → model proposes ONE allowlisted
 * routing action → strict zod validation → deterministic stage/transition/
 * precondition/context validation → validated decision. Relay then routes via
 * resolveRoute() and executes through the existing deterministic services.
 * Nothing here mutates workflow, payment, fulfillment, or allocation state.
 */
export class OrchestrationPlanner {
  private provider: ModelProvider;

  constructor(options?: { provider?: ModelProvider }) {
    this.provider = options?.provider ?? getModelProvider();
  }

  public async planNextAction(context: RoutingContext): Promise<RoutingResult> {
    const contextError = validateRoutingContext(context);
    if (contextError) {
      return { status: 'invalid', issues: [contextError] };
    }

    let response;
    try {
      response = await this.provider.generateWithTools({
        messages: [
          { role: 'system', content: ORCHESTRATION_SYSTEM_PROMPT },
          { role: 'user', content: this.renderContext(context) },
        ],
        tools: [PLAN_NEXT_ACTION_TOOL],
        temperature: 0.1,
        maxTokens: 2048,
        reasoningEffort: 'low',
      });
    } catch (err) {
      if (err instanceof ModelProviderError) {
        return { status: 'error', issues: [{ code: err.code, message: err.message }] };
      }
      return {
        status: 'error',
        issues: [
          {
            code: 'PROVIDER_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }

    const calls = (response.toolCalls ?? []).filter((c) => c.name === ORCHESTRATION_TOOL_NAME);
    if (calls.length === 0) {
      return {
        status: 'invalid',
        issues: [
          {
            code: 'NO_TOOL_CALL',
            message: 'Model did not return an orchestration tool call.',
          },
        ],
      };
    }
    if (calls.length > 1) {
      return {
        status: 'invalid',
        issues: [
          {
            code: 'MULTIPLE_TOOL_CALLS',
            message: 'Model returned more than one orchestration tool call.',
          },
        ],
      };
    }

    const parsed = rawDecisionSchema.safeParse(calls[0].arguments);
    if (!parsed.success) {
      return { status: 'invalid', issues: mapZodIssues(parsed.error) };
    }
    return validateDecision(parsed.data, context);
  }

  private renderContext(context: RoutingContext): string {
    const payload = {
      workflowId: context.workflowId,
      currentStage: context.currentStage,
      workflowStatus: context.workflowStatus,
      intent: {
        status: context.intent.status,
        itemCount: context.intent.quantities.length,
        quantities: context.intent.quantities,
        units: context.intent.units,
        deadlineHours: context.intent.deadlineHours,
      },
      suppliersDiscovered: context.suppliersDiscovered,
      suppliersQualified: context.suppliersQualified,
      quotesReceived: context.quotesReceived,
      quotesInterpreted: context.quotesInterpreted,
      rawResponsesPending: context.rawResponsesPending,
      negotiationRound: context.negotiationRound,
      negotiationMaxRounds: context.negotiationMaxRounds,
      negotiationEligible: context.negotiationEligible,
      awaitingExternal: context.awaitingExternal,
      blockers: context.blockers,
      communityQuantity: context.communityQuantity,
    };
    return (
      `Verified workflow context (JSON, authoritative — echo exactly, never change):\n` +
      `${JSON.stringify(payload)}\n\n` +
      'Call plan_next_procurement_action now with exactly one routing decision.'
    );
  }
}

export function validateRoutingContext(context: RoutingContext): RoutingIssue | null {
  const fail = (message: string): RoutingIssue => ({ code: 'INVALID_CONTEXT', message });
  if (!context.workflowId || context.workflowId.trim().length === 0) {
    return fail('Routing context is missing workflowId.');
  }
  if (!KNOWN_STAGES.includes(context.currentStage)) {
    return fail('Routing context has an unknown current stage.');
  }
  if (!Number.isInteger(context.suppliersDiscovered) || context.suppliersDiscovered < 0) {
    return fail('Routing context has invalid supplier counts.');
  }
  if (!Number.isInteger(context.suppliersQualified) || context.suppliersQualified < 0) {
    return fail('Routing context has invalid supplier counts.');
  }
  if (!Number.isInteger(context.quotesReceived) || context.quotesReceived < 0) {
    return fail('Routing context has invalid quote counts.');
  }
  if (!Number.isInteger(context.rawResponsesPending) || context.rawResponsesPending < 0) {
    return fail('Routing context has an invalid pending-response count.');
  }
  if (
    !Number.isInteger(context.negotiationRound) ||
    context.negotiationRound < 0 ||
    !Number.isInteger(context.negotiationMaxRounds) ||
    context.negotiationMaxRounds < 1
  ) {
    return fail('Routing context has invalid negotiation bounds.');
  }
  const quantities = context.intent?.quantities ?? [];
  const units = context.intent?.units ?? [];
  if (quantities.length !== units.length) {
    return fail('Routing context quantities and units are misaligned.');
  }
  if (quantities.some((q) => typeof q !== 'number' || !Number.isFinite(q) || q <= 0)) {
    return fail('Routing context has invalid quantities.');
  }
  return null;
}

export function validateDecision(
  raw: RawRoutingDecision,
  context: RoutingContext
): RoutingResult {
  const issues: RoutingIssue[] = [];
  const fail = (code: string, message: string) => {
    issues.push({ code, message });
  };

  // 1. Stage binding: known stages, exact current-stage echo, legal transition.
  if (!KNOWN_STAGES.includes(raw.currentStage as WorkflowStage)) {
    fail('UNKNOWN_STAGE', `Current stage "${raw.currentStage}" is not a Relay stage.`);
  } else if (raw.currentStage !== context.currentStage) {
    fail('STAGE_MISMATCH', 'Decision current stage does not match authoritative state.');
  }
  if (!KNOWN_STAGES.includes(raw.targetStage as WorkflowStage)) {
    fail('UNKNOWN_STAGE', `Target stage "${raw.targetStage}" is not a Relay stage.`);
  } else if (
    KNOWN_STAGES.includes(raw.currentStage as WorkflowStage) &&
    !canTransitionWorkflowStage(
      raw.currentStage as WorkflowStage,
      raw.targetStage as WorkflowStage
    )
  ) {
    fail(
      'ILLEGAL_TRANSITION',
      `Transition ${raw.currentStage} -> ${raw.targetStage} is not legal.`
    );
  }

  // 2. Priority coherence.
  if (ROUTING_ACTION_PRIORITY[raw.action] !== raw.priority) {
    fail(
      'PRIORITY_MISMATCH',
      `Priority ${raw.priority} does not match action ${raw.action}.`
    );
  }

  // 3. Target must match the action's Relay-owned route.
  const route = ROUTE_TABLE[raw.action];
  if (route.stage === null) {
    if (raw.targetStage !== context.currentStage) {
      fail(
        'TARGET_MISMATCH',
        `Action ${raw.action} must keep the current stage.`
      );
    }
  } else if (raw.targetStage !== route.stage) {
    fail(
      'TARGET_MISMATCH',
      `Action ${raw.action} must target stage ${route.stage}.`
    );
  }

  // 4. Terminal workflow: only STOP is valid.
  const isTerminal =
    TERMINAL_STATUSES.includes(context.workflowStatus) || context.currentStage === 'COMPLETE';
  if (isTerminal && raw.action !== 'STOP_AUTONOMOUS_RUN') {
    fail('WORKFLOW_TERMINAL', 'Only STOP_AUTONOMOUS_RUN is valid in a terminal workflow.');
  }

  // 5. Blockers: only clarification, waiting, or stop may proceed.
  if (
    context.blockers.length > 0 &&
    !STAY_ACTIONS.includes(raw.action)
  ) {
    fail('WORKFLOW_BLOCKED', 'Progress actions are barred while blockers are present.');
  }

  // 6. Verified-commercial echoes must match exactly (no tampering, no invention).
  const expectedCount = context.intent.quantities.length;
  if (raw.verifiedContext.itemCount !== expectedCount) {
    fail('ITEM_COUNT_MISMATCH', 'Decision item count does not match verified intent.');
  }
  if (
    raw.verifiedContext.quantities.length !== expectedCount ||
    raw.verifiedContext.quantities.some((q, i) => q !== context.intent.quantities[i])
  ) {
    fail('QUANTITY_TAMPERED', 'Decision changed verified quantities.');
  }
  if (
    raw.verifiedContext.units.length !== expectedCount ||
    raw.verifiedContext.units.some((u, i) => u !== context.intent.units[i])
  ) {
    fail('UNIT_TAMPERED', 'Decision changed verified units.');
  }
  if (context.intent.deadlineHours === undefined) {
    if (raw.verifiedContext.deadlineHours !== undefined) {
      fail('DEADLINE_TAMPERED', 'Decision invents a deadline the intent does not state.');
    }
  } else if (raw.verifiedContext.deadlineHours !== context.intent.deadlineHours) {
    fail('DEADLINE_TAMPERED', 'Decision changed the verified deadline.');
  }

  // 7. Per-action preconditions (mirror validateStagePreconditions semantics).
  switch (raw.action) {
    case 'UNDERSTAND_REQUEST':
      if (context.intent.status === 'resolved') {
        fail('INTENT_ALREADY_RESOLVED', 'Intent is already resolved.');
      }
      break;
    case 'PLAN_DISCOVERY':
      if (context.intent.status !== 'resolved') {
        fail('PRECONDITION_FAILED', 'Discovery requires resolved intent.');
      }
      break;
    case 'QUALIFY_SUPPLIERS':
      if (context.suppliersDiscovered === 0) {
        fail('PRECONDITION_FAILED', 'Qualification requires discovered suppliers.');
      }
      break;
    case 'REQUEST_QUOTES':
      if (context.suppliersQualified === 0) {
        fail('PRECONDITION_FAILED', 'RFQ dispatch requires qualified suppliers.');
      }
      break;
    case 'INTERPRET_QUOTES':
      if (context.rawResponsesPending === 0) {
        fail('PRECONDITION_FAILED', 'Interpretation requires pending raw responses.');
      }
      break;
    case 'PLAN_NEGOTIATION':
      if (!context.negotiationEligible) {
        fail('PRECONDITION_FAILED', 'Negotiation is not eligible.');
      }
      break;
    case 'SELECT_SUPPLIER':
      if (context.quotesReceived === 0) {
        fail('PRECONDITION_FAILED', 'Selection requires verified quotes.');
      }
      break;
    case 'REQUEST_CLARIFICATION':
    case 'WAIT_FOR_EXTERNAL_RESPONSE':
    case 'STOP_AUTONOMOUS_RUN':
      break;
  }

  // 8. Required capabilities/context must name known vocabulary that exists.
  for (const capability of raw.requiredCapabilities ?? []) {
    if (!(ORCHESTRATION_ACTIONS as readonly string[]).includes(capability)) {
      fail('UNKNOWN_CAPABILITY', `Unknown capability "${capability}".`);
    }
  }
  const availability = availabilityOf(context);
  for (const name of raw.requiredContext ?? []) {
    if (!(CONTEXT_VOCABULARY as readonly string[]).includes(name)) {
      fail('UNKNOWN_CONTEXT', `Unknown context "${name}".`);
    } else if (!availability[name]) {
      fail('MISSING_REQUIRED_CONTEXT', `Required context "${name}" is not available.`);
    }
  }

  // 9. Safety screening for all model-authored text.
  const texts: Array<[string, string]> = [
    ['objective', raw.objective],
    ['rationale', raw.rationale],
    ...(raw.constraintsAcknowledged ?? []).map(
      (t, i) => [`constraintsAcknowledged[${i}]`, t] as [string, string]
    ),
    ...raw.stopConditions.map((t, i) => [`stopConditions[${i}]`, t] as [string, string]),
  ];
  for (const [label, text] of texts) {
    const verdict = screenRoutingText(text);
    if (verdict !== 'ok') {
      fail(verdict, `Decision text "${label}" failed safety screening.`);
    }
  }

  if (issues.length > 0) {
    return { status: 'invalid', issues };
  }
  return {
    status: 'ok',
    decision: {
      action: raw.action,
      currentStage: raw.currentStage as WorkflowStage,
      targetStage: raw.targetStage as WorkflowStage,
      priority: raw.priority,
      objective: raw.objective,
      rationale: raw.rationale,
      itemCount: raw.verifiedContext.itemCount,
      quantities: [...raw.verifiedContext.quantities],
      units: [...raw.verifiedContext.units],
      deadlineHours: raw.verifiedContext.deadlineHours,
      requiredCapabilities: [...(raw.requiredCapabilities ?? [])],
      requiredContext: [...(raw.requiredContext ?? [])],
      constraintsAcknowledged: [...(raw.constraintsAcknowledged ?? [])],
      stopConditions: [...raw.stopConditions],
    },
    issues: [],
  };
}

export interface WorkflowRoutingFacts {
  intentStatus: 'resolved' | 'ambiguous' | 'unresolved' | 'missing';
  quantities: number[];
  units: string[];
  deadlineHours?: number;
  rawResponsesPending: number;
  negotiationRound: number;
  negotiationMaxRounds: number;
  negotiationEligible: boolean;
  awaitingExternal: boolean;
  blockers: string[];
  communityQuantity?: number;
}

/**
 * Derives a routing context from a live authoritative RelayWorkflow plus
 * caller-verified commercial facts. Stage, status, and entity counts come
 * straight from the workflow aggregate; nothing is inferred by the model.
 */
export function workflowToRoutingContext(
  workflow: RelayWorkflow,
  facts: WorkflowRoutingFacts
): RoutingContext {
  return {
    workflowId: workflow.id,
    currentStage: workflow.currentStage,
    workflowStatus: workflow.status,
    intent: {
      status: facts.intentStatus,
      quantities: [...facts.quantities],
      units: [...facts.units],
      deadlineHours: facts.deadlineHours,
    },
    suppliersDiscovered: workflow.entities.supplierCandidateIds?.length ?? 0,
    suppliersQualified: workflow.entities.qualifiedSupplierIds?.length ?? 0,
    quotesReceived: workflow.entities.receivedQuoteIds?.length ?? 0,
    quotesInterpreted: workflow.entities.negotiatedQuoteIds?.length ?? 0,
    rawResponsesPending: facts.rawResponsesPending,
    negotiationRound: facts.negotiationRound,
    negotiationMaxRounds: facts.negotiationMaxRounds,
    negotiationEligible: facts.negotiationEligible,
    awaitingExternal: facts.awaitingExternal,
    blockers: [...facts.blockers],
    communityQuantity: facts.communityQuantity,
  };
}
