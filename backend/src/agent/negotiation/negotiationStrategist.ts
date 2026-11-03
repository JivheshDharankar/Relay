import { ZodError } from 'zod';
import { ModelProvider, ModelProviderError, getModelProvider } from '../model';
import type { CreateProposalInput } from '../../discovery/supplier/negotiation/NegotiationService';
import type { NegotiationStrategy as EngineStrategy } from '../../discovery/supplier/negotiation/types';
import {
  isGreaterThanOrEqual,
  isPositive,
  subtractDecimals,
  toDecimal,
} from '../../domain/procurement/decimal';
import {
  ACTION_PRIORITY,
  NEGOTIATION_STRATEGY_SYSTEM_PROMPT,
  NEGOTIATION_TOOL_NAME,
  PROPOSE_NEGOTIATION_STRATEGY_TOOL,
  RawNegotiationStrategy,
  StrategyActionType,
  TERMINAL_ACTIONS,
  rawStrategySchema,
  screenStrategyText,
} from './negotiationSchema';

export type StrategyStatus = 'ok' | 'invalid' | 'error';

/** Relay-owned verified negotiation context. The model echoes it; Relay checks it. */
export interface StrategyContext {
  negotiationId: string;
  quoteId: string;
  rfqId: string;
  candidateId: string;
  supplierName: string;
  productId: string;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  deliveryFee: number;
  deliveryEtaHours?: number;
  moqQuantity?: number;
  slaMaxHours: number;
  slaDeadline: Date;
  currentRound: number;
  maxRounds: number;
  policy: {
    minPriceImprovementPercent: number;
    minPriceImprovementAbsolute: number;
    minDeliveryHoursImprovement: number;
    maxDiscountPercent: number;
  };
  communityQuantity?: number;
  competitorNames?: string[];
}

export interface ValidatedStrategyTarget {
  targetUnitPrice?: number;
  targetDeliveryFee?: number;
  targetDeliveryEtaHours?: number;
  targetQuantity?: number;
  notes?: string;
}

export interface ValidatedStrategy {
  action: StrategyActionType;
  priority: string;
  objective: string;
  quoteId: string;
  rfqId: string;
  supplierId: string;
  productId: string;
  productName: string;
  quantity: number;
  unit: string;
  roundNumber: number;
  communityQuantity?: number;
  clarificationTopic?: string;
  requestedChange?: ValidatedStrategyTarget;
  rationale: string;
  expectedBenefit: string;
  constraintsAcknowledged: string[];
  stopConditions: string[];
}

export interface StrategyIssue {
  code: string;
  message: string;
}

export interface StrategyResult {
  status: StrategyStatus;
  strategy?: ValidatedStrategy;
  issues: StrategyIssue[];
}

export type StrategyConversion =
  | { convertible: true; input: CreateProposalInput }
  | { convertible: false; terminal: boolean; reason: string };

function mapZodIssues(error: ZodError): StrategyIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    if (issue.code === 'unrecognized_keys') {
      return {
        code: 'EXTRA_FIELD',
        message: `Strategy contains unauthorized field(s) at ${path || 'root'}: ${issue.keys.join(', ')}`,
      };
    }
    return {
      code: 'SCHEMA_VIOLATION',
      message: `Strategy failed validation at ${path || 'root'}: ${issue.message}`,
    };
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Phase 14.5 — deterministic negotiation-strategy service.
 *
 * Flow: Relay-owned verified context → model proposes ONE allowlisted
 * strategy → strict zod validation → deterministic echo/identity/round/SLA/
 * improvement validation → validated strategy. Numeric strategies convert to
 * the existing engine's CreateProposalInput via strategyToProposalInput; the
 * engine's own validator remains the final gate.
 */
export class NegotiationStrategist {
  private provider: ModelProvider;

  constructor(options?: { provider?: ModelProvider }) {
    this.provider = options?.provider ?? getModelProvider();
  }

  public async propose(context: StrategyContext): Promise<StrategyResult> {
    const contextError = validateStrategyContext(context);
    if (contextError) {
      return { status: 'invalid', issues: [contextError] };
    }

    let response;
    try {
      response = await this.provider.generateWithTools({
        messages: [
          { role: 'system', content: NEGOTIATION_STRATEGY_SYSTEM_PROMPT },
          { role: 'user', content: this.renderContext(context) },
        ],
        tools: [PROPOSE_NEGOTIATION_STRATEGY_TOOL],
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

    const calls = (response.toolCalls ?? []).filter((c) => c.name === NEGOTIATION_TOOL_NAME);
    if (calls.length === 0) {
      return {
        status: 'invalid',
        issues: [
          {
            code: 'NO_TOOL_CALL',
            message: 'Model did not return a negotiation-strategy tool call.',
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
            message: 'Model returned more than one strategy tool call.',
          },
        ],
      };
    }

    const parsed = rawStrategySchema.safeParse(calls[0].arguments);
    if (!parsed.success) {
      return { status: 'invalid', issues: mapZodIssues(parsed.error) };
    }
    return validateStrategy(parsed.data, context);
  }

  private renderContext(context: StrategyContext): string {
    const payload = {
      negotiationId: context.negotiationId,
      quoteId: context.quoteId,
      rfqId: context.rfqId,
      supplierId: context.candidateId,
      supplierName: context.supplierName,
      productId: context.productId,
      productName: context.productName,
      quantity: context.quantity,
      unit: context.unit,
      unitPrice: context.unitPrice,
      deliveryFee: context.deliveryFee,
      deliveryEtaHours: context.deliveryEtaHours,
      moqQuantity: context.moqQuantity,
      slaMaxHours: context.slaMaxHours,
      currentRound: context.currentRound,
      maxRounds: context.maxRounds,
      policy: context.policy,
      communityQuantity: context.communityQuantity,
    };
    return (
      `Verified negotiation context (JSON, authoritative — echo exactly, never change):\n` +
      `${JSON.stringify(payload)}\n\n` +
      'Call propose_negotiation_strategy now with exactly one strategy.'
    );
  }
}

export function validateStrategyContext(context: StrategyContext): StrategyIssue | null {
  const fail = (message: string): StrategyIssue => ({ code: 'INVALID_CONTEXT', message });
  for (const key of [
    'negotiationId',
    'quoteId',
    'rfqId',
    'candidateId',
    'supplierName',
    'productId',
    'productName',
    'unit',
  ] as const) {
    if (!isNonEmptyString(context[key])) {
      return fail(`Strategy context is missing ${key}.`);
    }
  }
  if (!isFiniteNumber(context.quantity) || context.quantity <= 0) {
    return fail('Strategy context has an invalid quantity.');
  }
  if (!isFiniteNumber(context.unitPrice) || context.unitPrice < 0) {
    return fail('Strategy context has an invalid unit price.');
  }
  if (!isFiniteNumber(context.deliveryFee) || context.deliveryFee < 0) {
    return fail('Strategy context has an invalid delivery fee.');
  }
  if (
    !Number.isInteger(context.currentRound) ||
    context.currentRound < 0 ||
    !Number.isInteger(context.maxRounds) ||
    context.maxRounds < 1
  ) {
    return fail('Strategy context has invalid round bounds.');
  }
  if (!isFiniteNumber(context.slaMaxHours) || context.slaMaxHours <= 0) {
    return fail('Strategy context has an invalid SLA.');
  }
  if (!(context.slaDeadline instanceof Date) || Number.isNaN(context.slaDeadline.getTime())) {
    return fail('Strategy context has an invalid SLA deadline.');
  }
  return null;
}

function screenAll(
  raw: RawNegotiationStrategy,
  competitorNames: string[] | undefined,
  issues: StrategyIssue[]
): void {
  const texts: Array<[string, string]> = [
    ['objective', raw.objective],
    ['rationale', raw.rationale],
    ['expectedBenefit', raw.expectedBenefit],
    ...(raw.requestedChange?.notes ? [['notes', raw.requestedChange.notes] as [string, string]] : []),
    ...(raw.clarificationTopic
      ? [['clarificationTopic', raw.clarificationTopic] as [string, string]]
      : []),
    ...(raw.constraintsAcknowledged ?? []).map(
      (t, i) => [`constraintsAcknowledged[${i}]`, t] as [string, string]
    ),
    ...raw.stopConditions.map((t, i) => [`stopConditions[${i}]`, t] as [string, string]),
  ];
  for (const [label, text] of texts) {
    const verdict = screenStrategyText(text);
    if (verdict !== 'ok') {
      issues.push({ code: verdict, message: `Strategy text "${label}" failed safety screening.` });
    }
  }
  if (competitorNames) {
    const combined = texts.map(([, text]) => text).join('\n');
    for (const competitor of competitorNames) {
      if (competitor.trim().length === 0) continue;
      const escaped = competitor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(combined)) {
        issues.push({
          code: 'CONFIDENTIALITY_VIOLATION',
          message: 'Strategy reveals a competitor supplier identity.',
        });
      }
    }
  }
}

export function validateStrategy(
  raw: RawNegotiationStrategy,
  context: StrategyContext
): StrategyResult {
  const issues: StrategyIssue[] = [];
  const fail = (code: string, message: string) => {
    issues.push({ code, message });
  };

  // 1. Identity and commercial echoes must match verified context exactly.
  if (raw.quoteId !== context.quoteId) fail('QUOTE_MISMATCH', 'Strategy quoteId does not match.');
  if (raw.rfqId !== context.rfqId) fail('RFQ_MISMATCH', 'Strategy rfqId does not match.');
  if (raw.supplierId !== context.candidateId) {
    fail('SUPPLIER_MISMATCH', 'Strategy supplierId does not match.');
  }
  if (raw.productId !== context.productId) {
    fail('PRODUCT_MISMATCH', 'Strategy productId does not match.');
  }
  if (raw.productName.toLowerCase() !== context.productName.toLowerCase()) {
    fail('PRODUCT_MISMATCH', 'Strategy productName does not match.');
  }
  if (raw.quantity !== context.quantity) {
    fail('QUANTITY_TAMPERED', 'Strategy changed the verified quantity.');
  }
  if (raw.unit !== context.unit) {
    fail('UNIT_TAMPERED', 'Strategy changed the verified unit.');
  }
  if (raw.roundNumber !== context.currentRound) {
    fail('ROUND_MISMATCH', 'Strategy round does not match the current round.');
  }

  // 2. Priority must cohere with the action.
  if (ACTION_PRIORITY[raw.action] !== raw.priority) {
    fail(
      'PRIORITY_MISMATCH',
      `Priority ${raw.priority} does not match action ${raw.action}.`
    );
  }

  // 3. Round bounds: past the maximum, only terminal actions are valid.
  const roundsExhausted = context.currentRound + 1 > context.maxRounds;
  if (roundsExhausted && !TERMINAL_ACTIONS.includes(raw.action)) {
    fail(
      'ROUND_LIMIT_EXCEEDED',
      `Round ${context.currentRound + 1} exceeds maximum ${context.maxRounds}.`
    );
  }

  // 4. Per-action target rules.
  const change = raw.requestedChange ?? {};
  const numericTargets = (
    ['targetUnitPrice', 'targetDeliveryFee', 'targetDeliveryEtaHours', 'targetQuantity'] as const
  ).filter((key) => change[key] !== undefined);
  const forbidTargets = () => {
    if (numericTargets.length > 0) {
      fail('TARGET_NOT_ALLOWED', `Action ${raw.action} must not carry a numeric target.`);
    }
  };
  const requireSingleTarget = (key: (typeof numericTargets)[number]) => {
    if (change[key] === undefined) {
      fail('TARGET_REQUIRED', `Action ${raw.action} requires ${key}.`);
    } else if (numericTargets.length > 1) {
      fail('MIXED_TARGETS', `Action ${raw.action} allows exactly one numeric target.`);
    }
  };

  switch (raw.action) {
    case 'REQUEST_PRICE_REDUCTION': {
      requireSingleTarget('targetUnitPrice');
      const target = change.targetUnitPrice;
      if (target !== undefined && numericTargets.length === 1) {
        if (!(target < context.unitPrice)) {
          fail('TARGET_EXCEEDS_CURRENT', 'Target unit price must be below the quoted price.');
        } else {
          const diff = subtractDecimals(context.unitPrice, target);
          const minAbsolute = toDecimal(context.policy.minPriceImprovementAbsolute);
          const percent = isPositive(toDecimal(context.unitPrice))
            ? diff.dividedBy(toDecimal(context.unitPrice)).times(100).toNumber()
            : 0;
          if (percent > context.policy.maxDiscountPercent) {
            fail(
              'UNREALISTIC_DISCOUNT',
              `Requested discount ${percent.toFixed(1)}% exceeds maximum ${context.policy.maxDiscountPercent}%.`
            );
          } else if (
            !(
              isGreaterThanOrEqual(diff, minAbsolute) ||
              percent >= context.policy.minPriceImprovementPercent
            )
          ) {
            fail(
              'NO_MEANINGFUL_IMPROVEMENT',
              'Target unit price does not meet the minimum improvement threshold.'
            );
          }
        }
      }
      break;
    }
    case 'REQUEST_DELIVERY_FEE_REDUCTION': {
      requireSingleTarget('targetDeliveryFee');
      const target = change.targetDeliveryFee;
      if (target !== undefined && numericTargets.length === 1) {
        if (!(target < context.deliveryFee)) {
          fail('TARGET_EXCEEDS_CURRENT', 'Target delivery fee must be below the quoted fee.');
        } else {
          const diff = subtractDecimals(context.deliveryFee, target);
          if (!isGreaterThanOrEqual(diff, toDecimal(context.policy.minPriceImprovementAbsolute))) {
            fail(
              'NO_MEANINGFUL_IMPROVEMENT',
              'Target delivery fee does not meet the minimum improvement threshold.'
            );
          }
        }
      }
      break;
    }
    case 'REQUEST_DELIVERY_IMPROVEMENT': {
      requireSingleTarget('targetDeliveryEtaHours');
      const target = change.targetDeliveryEtaHours;
      if (target !== undefined && numericTargets.length === 1) {
        if (context.deliveryEtaHours === undefined) {
          fail('DELIVERY_UNKNOWN', 'Cannot improve an unknown delivery ETA.');
        } else if (!(target < context.deliveryEtaHours)) {
          fail('TARGET_EXCEEDS_CURRENT', 'Target delivery ETA must beat the quoted ETA.');
        } else if (
          context.deliveryEtaHours - target <
          context.policy.minDeliveryHoursImprovement
        ) {
          fail(
            'NO_MEANINGFUL_IMPROVEMENT',
            'Target delivery ETA does not meet the minimum improvement threshold.'
          );
        }
        const requestedDate = new Date(Date.now() + (target ?? 0) * 3600 * 1000);
        if (requestedDate.getTime() > context.slaDeadline.getTime()) {
          fail('SLA_VIOLATION', 'Target delivery ETA violates the hard SLA deadline.');
        }
      }
      break;
    }
    case 'REQUEST_LOWER_MOQ': {
      requireSingleTarget('targetQuantity');
      if (change.targetQuantity !== undefined && change.targetQuantity !== context.quantity) {
        fail(
          'QUANTITY_TAMPERED',
          'MOQ requests must target exactly the verified required quantity.'
        );
      }
      break;
    }
    case 'REQUEST_BUNDLE_DISCOUNT': {
      forbidTargets();
      if (context.communityQuantity === undefined) {
        fail('NO_COMMUNITY_BASIS', 'Bundle requests require verified community quantity.');
      } else if (raw.communityQuantity !== context.communityQuantity) {
        fail(
          'COMMUNITY_QUANTITY_MISMATCH',
          'Bundle community quantity does not match verified demand.'
        );
      }
      break;
    }
    case 'REQUEST_CLARIFICATION': {
      forbidTargets();
      if (!raw.clarificationTopic || raw.clarificationTopic.trim().length === 0) {
        fail('TOPIC_REQUIRED', 'Clarification requests require a topic.');
      }
      break;
    }
    case 'ACCEPT_CURRENT_OFFER':
    case 'STOP_NEGOTIATION': {
      forbidTargets();
      break;
    }
  }

  // 5. Safety screening for all model-authored text.
  screenAll(raw, context.competitorNames, issues);

  if (issues.length > 0) {
    return { status: 'invalid', issues };
  }
  return {
    status: 'ok',
    strategy: {
      action: raw.action,
      priority: raw.priority,
      objective: raw.objective,
      quoteId: raw.quoteId,
      rfqId: raw.rfqId,
      supplierId: raw.supplierId,
      productId: raw.productId,
      productName: raw.productName,
      quantity: raw.quantity,
      unit: raw.unit,
      roundNumber: raw.roundNumber,
      communityQuantity: raw.communityQuantity,
      clarificationTopic: raw.clarificationTopic,
      requestedChange:
        raw.requestedChange === undefined
          ? undefined
          : {
              targetUnitPrice: raw.requestedChange.targetUnitPrice,
              targetDeliveryFee: raw.requestedChange.targetDeliveryFee,
              targetDeliveryEtaHours: raw.requestedChange.targetDeliveryEtaHours,
              targetQuantity: raw.requestedChange.targetQuantity,
              notes: raw.requestedChange.notes,
            },
      rationale: raw.rationale,
      expectedBenefit: raw.expectedBenefit,
      constraintsAcknowledged: raw.constraintsAcknowledged ?? [],
      stopConditions: raw.stopConditions,
    },
    issues: [],
  };
}

const ACTION_TO_ENGINE_STRATEGY: Record<
  Extract<
    StrategyActionType,
    'REQUEST_PRICE_REDUCTION' | 'REQUEST_DELIVERY_FEE_REDUCTION' | 'REQUEST_DELIVERY_IMPROVEMENT'
  >,
  EngineStrategy
> = {
  REQUEST_PRICE_REDUCTION: 'LOWER_PRICE',
  REQUEST_DELIVERY_FEE_REDUCTION: 'REDUCE_DELIVERY_FEE',
  REQUEST_DELIVERY_IMPROVEMENT: 'IMPROVE_DELIVERY_TIME',
};

/**
 * Converts a validated numeric strategy into the existing engine's
 * CreateProposalInput. Non-numeric strategies (MOQ/bundle/clarification) and
 * terminal strategies (accept/stop) are explicitly non-convertible: the
 * engine has no lever for them, and Relay builds the supplier message itself,
 * so the conversion never forwards model-authored supplier text.
 */
export function strategyToProposalInput(
  strategy: ValidatedStrategy,
  context: StrategyContext
): StrategyConversion {
  if (TERMINAL_ACTIONS.includes(strategy.action)) {
    return {
      convertible: false,
      terminal: true,
      reason: `Action ${strategy.action} ends negotiation without a proposal.`,
    };
  }
  const engineStrategy = ACTION_TO_ENGINE_STRATEGY[
    strategy.action as keyof typeof ACTION_TO_ENGINE_STRATEGY
  ];
  if (!engineStrategy) {
    return {
      convertible: false,
      terminal: false,
      reason: `Action ${strategy.action} has no engine proposal lever; recorded as reasoning only.`,
    };
  }
  const change = strategy.requestedChange ?? {};
  return {
    convertible: true,
    input: {
      negotiationId: context.negotiationId,
      strategy: engineStrategy,
      requestedChanges: {
        targetUnitPrice: change.targetUnitPrice,
        targetDeliveryFee: change.targetDeliveryFee,
        targetDeliveryEtaHours: change.targetDeliveryEtaHours,
      },
      rationale: strategy.rationale,
      expectedBenefit: strategy.expectedBenefit,
    },
  };
}
