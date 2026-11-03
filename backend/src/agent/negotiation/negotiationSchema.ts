import { z } from 'zod';
import { ToolDefinition } from '../model/types';

/**
 * Phase 14.5 — AI negotiation-strategy contract.
 *
 * Meta proposes WHICH commercial lever to negotiate and a bounded target.
 * Relay validates the proposal against the verified quote, the negotiation
 * state, and the deterministic policy, then converts numeric strategies into
 * the existing engine's CreateProposalInput. The model can never pay,
 * authorize, select suppliers, mutate quantities, or weaken hard constraints:
 * the strict schemas below have no such fields, and unknown action names are
 * rejected by the allowlist enum.
 */

export const NEGOTIATION_TOOL_NAME = 'propose_negotiation_strategy';

export const STRATEGY_ACTIONS = [
  'REQUEST_PRICE_REDUCTION',
  'REQUEST_LOWER_MOQ',
  'REQUEST_DELIVERY_IMPROVEMENT',
  'REQUEST_DELIVERY_FEE_REDUCTION',
  'REQUEST_BUNDLE_DISCOUNT',
  'REQUEST_CLARIFICATION',
  'ACCEPT_CURRENT_OFFER',
  'STOP_NEGOTIATION',
] as const;
export type StrategyActionType = (typeof STRATEGY_ACTIONS)[number];

export const STRATEGY_PRIORITIES = [
  'PRICE',
  'MOQ',
  'DELIVERY',
  'DELIVERY_FEE',
  'BUNDLE',
  'CLARIFICATION',
  'NONE',
] as const;
export type StrategyPriority = (typeof STRATEGY_PRIORITIES)[number];

/** Action → required priority coherence mapping. */
export const ACTION_PRIORITY: Record<StrategyActionType, StrategyPriority> = {
  REQUEST_PRICE_REDUCTION: 'PRICE',
  REQUEST_LOWER_MOQ: 'MOQ',
  REQUEST_DELIVERY_IMPROVEMENT: 'DELIVERY',
  REQUEST_DELIVERY_FEE_REDUCTION: 'DELIVERY_FEE',
  REQUEST_BUNDLE_DISCOUNT: 'BUNDLE',
  REQUEST_CLARIFICATION: 'CLARIFICATION',
  ACCEPT_CURRENT_OFFER: 'NONE',
  STOP_NEGOTIATION: 'NONE',
};

export const TERMINAL_ACTIONS: StrategyActionType[] = [
  'ACCEPT_CURRENT_OFFER',
  'STOP_NEGOTIATION',
];

// Mirrors DeterministicNegotiationValidator guardrails (defense in depth;
// the engine re-checks on conversion).
const FORBIDDEN_PATTERN_PII =
  /\b(flat\s*\d+|tower\s*[a-z0-9]|res_[a-z0-9_]+|resident|apartment\s*\d+|mandate|budget\s*limit|spending\s*limit)\b/i;
const FORBIDDEN_PATTERN_AI =
  /\b(system\s*prompt|as\s*an?\s*ai|language\s*model|instructions\s*given)\b/i;

export function screenStrategyText(text: string): 'ok' | 'PRIVACY_VIOLATION' | 'PROMPT_LEAKAGE' {
  if (FORBIDDEN_PATTERN_PII.test(text)) return 'PRIVACY_VIOLATION';
  if (FORBIDDEN_PATTERN_AI.test(text)) return 'PROMPT_LEAKAGE';
  return 'ok';
}

const requestedChangeSchema = z
  .object({
    targetUnitPrice: z.number().finite().min(0).optional(),
    targetDeliveryFee: z.number().finite().min(0).optional(),
    targetDeliveryEtaHours: z.number().finite().positive().optional(),
    targetQuantity: z.number().finite().positive().optional(),
    notes: z.string().max(500).optional(),
  })
  .strict();

export const rawStrategySchema = z
  .object({
    action: z.enum(STRATEGY_ACTIONS),
    priority: z.enum(STRATEGY_PRIORITIES),
    objective: z.string().min(1).max(500),
    quoteId: z.string().min(1).max(64),
    rfqId: z.string().min(1).max(64),
    supplierId: z.string().min(1).max(64),
    productId: z.string().min(1).max(64),
    productName: z.string().min(1).max(120),
    quantity: z.number(),
    unit: z.string().min(1).max(16),
    roundNumber: z.number().int().min(0),
    communityQuantity: z.number().finite().positive().optional(),
    clarificationTopic: z.string().min(1).max(200).optional(),
    requestedChange: requestedChangeSchema.optional(),
    rationale: z.string().min(1).max(1000),
    expectedBenefit: z.string().min(1).max(500),
    constraintsAcknowledged: z.array(z.string().min(1).max(120)).max(8).optional(),
    stopConditions: z.array(z.string().min(1).max(200)).min(1).max(5),
  })
  .strict();

export type RawNegotiationStrategy = z.infer<typeof rawStrategySchema>;

/**
 * Inference-only tool definition for negotiation strategy.
 * Deliberately NOT registered in the executable ToolRegistry.
 */
export const PROPOSE_NEGOTIATION_STRATEGY_TOOL: ToolDefinition = {
  name: NEGOTIATION_TOOL_NAME,
  description:
    'Propose a negotiation strategy for a verified quote. Call exactly once. Use these exact field names.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: `One of: ${(STRATEGY_ACTIONS as readonly string[]).join(', ')}.`,
      },
      priority: {
        type: 'string',
        description: `One of: ${(STRATEGY_PRIORITIES as readonly string[]).join(', ')}. Must match the action.`,
      },
      objective: { type: 'string' },
      quoteId: { type: 'string', description: 'Copy exactly from context.' },
      rfqId: { type: 'string', description: 'Copy exactly from context.' },
      supplierId: { type: 'string', description: 'Copy exactly from context.' },
      productId: { type: 'string', description: 'Copy exactly from context.' },
      productName: { type: 'string', description: 'Copy exactly from context.' },
      quantity: { type: 'number', description: 'Copy exactly from context.' },
      unit: { type: 'string', description: 'Copy exactly from context.' },
      roundNumber: { type: 'number', description: 'Copy the current round exactly from context.' },
      communityQuantity: { type: 'number', description: 'Copy exactly when requesting a bundle discount.' },
      clarificationTopic: { type: 'string', description: 'Required when requesting clarification.' },
      requestedChange: {
        type: 'object',
        description: 'Exactly one numeric target matching the action; required for price/fee/delivery/MOQ actions.',
        properties: {
          targetUnitPrice: { type: 'number' },
          targetDeliveryFee: { type: 'number' },
          targetDeliveryEtaHours: { type: 'number' },
          targetQuantity: { type: 'number' },
          notes: { type: 'string' },
        },
      },
      rationale: { type: 'string' },
      expectedBenefit: { type: 'string' },
      constraintsAcknowledged: { type: 'array', items: { type: 'string' } },
      stopConditions: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'action',
      'priority',
      'objective',
      'quoteId',
      'rfqId',
      'supplierId',
      'productId',
      'productName',
      'quantity',
      'unit',
      'roundNumber',
      'rationale',
      'expectedBenefit',
      'stopConditions',
    ],
  },
};

export const NEGOTIATION_STRATEGY_SYSTEM_PROMPT = [
  'You reason about supplier negotiation strategy for the Relay procurement platform.',
  'You receive verified quote and negotiation context as JSON. You MUST call propose_negotiation_strategy exactly once and MUST NOT reply in prose.',
  'Rules:',
  '1. action must be one of: REQUEST_PRICE_REDUCTION, REQUEST_LOWER_MOQ, REQUEST_DELIVERY_IMPROVEMENT, REQUEST_DELIVERY_FEE_REDUCTION, REQUEST_BUNDLE_DISCOUNT, REQUEST_CLARIFICATION, ACCEPT_CURRENT_OFFER, STOP_NEGOTIATION. No other action exists.',
  '2. priority must match the action: price->PRICE, MOQ->MOQ, delivery->DELIVERY, fee->DELIVERY_FEE, bundle->BUNDLE, clarification->CLARIFICATION, accept/stop->NONE.',
  '3. Copy quoteId, rfqId, supplierId, productId, productName, quantity, unit, and roundNumber EXACTLY from context. Never change them.',
  '4. requestedChange carries exactly one numeric target matching the action: targetUnitPrice (strictly below current, realistic single-digit-percent improvement), targetDeliveryFee (strictly below current), targetDeliveryEtaHours (strictly below current ETA and within the SLA), or targetQuantity equal to the required quantity for MOQ requests. Bundle, clarification, accept, and stop actions carry NO numeric target.',
  '5. If the next round would exceed maximum rounds, only ACCEPT_CURRENT_OFFER or STOP_NEGOTIATION is valid.',
  '6. Never propose weakening the delivery commitment, changing products or quantities, paying, authorizing, refunding, selecting suppliers, or skipping qualification. State at least one stop condition protecting the delivery commitment.',
  '7. Never invent supplier responses, counter-offers, acceptances, prices, availability, ratings, discounts, or payment terms. Never include resident PII, addresses, mandates, or budget data in any text.',
].join('\n');
