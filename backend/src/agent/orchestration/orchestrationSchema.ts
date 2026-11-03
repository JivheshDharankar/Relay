import { z } from 'zod';
import { ToolDefinition } from '../model/types';
import { WorkflowStage } from '../../orchestration/types';

/**
 * Phase 15 — AI orchestration & decision-routing contract.
 *
 * Meta reasons about WHICH verified Relay capability should run next and
 * proposes one allowlisted routing action. Relay validates the proposal
 * against the authoritative workflow stage (using the existing state
 * machine), verified context, and policy — then routes through the existing
 * deterministic services. The model can never invent stages, tools,
 * endpoints, IDs, prices, suppliers, or state transitions: the strict schema
 * has no such fields.
 */

export const ORCHESTRATION_TOOL_NAME = 'plan_next_procurement_action';

/** Mirrors WorkflowStage (orchestration/types); legality via canTransitionWorkflowStage. */
export const KNOWN_STAGES: WorkflowStage[] = [
  'UNDERSTAND',
  'DISCOVER',
  'QUALIFY',
  'QUOTE',
  'NEGOTIATE',
  'SELECT',
  'COMMIT',
  'PAY',
  'FULFILL',
  'VERIFY',
  'ALLOCATE',
  'RECONCILE',
  'COMPLETE',
];

export const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'];

export const ORCHESTRATION_ACTIONS = [
  'UNDERSTAND_REQUEST',
  'PLAN_DISCOVERY',
  'QUALIFY_SUPPLIERS',
  'REQUEST_QUOTES',
  'INTERPRET_QUOTES',
  'PLAN_NEGOTIATION',
  'SELECT_SUPPLIER',
  'REQUEST_CLARIFICATION',
  'WAIT_FOR_EXTERNAL_RESPONSE',
  'STOP_AUTONOMOUS_RUN',
] as const;
export type OrchestrationAction = (typeof ORCHESTRATION_ACTIONS)[number];

export const STAY_ACTIONS: OrchestrationAction[] = [
  'REQUEST_CLARIFICATION',
  'WAIT_FOR_EXTERNAL_RESPONSE',
  'STOP_AUTONOMOUS_RUN',
];

/** Relay-owned route table: semantic action → capability + workflow stage. */
export interface CapabilityRoute {
  capability:
    | 'intent-extractor'
    | 'discovery-planner'
    | 'quote-interpreter'
    | 'negotiation-strategist'
    | 'relay-deterministic';
  /** Target workflow stage, or null when the action intentionally stays. */
  stage: WorkflowStage | null;
  deterministicService?: string;
}

export const ROUTE_TABLE: Record<OrchestrationAction, CapabilityRoute> = {
  UNDERSTAND_REQUEST: { capability: 'intent-extractor', stage: 'UNDERSTAND' },
  PLAN_DISCOVERY: { capability: 'discovery-planner', stage: 'DISCOVER' },
  QUALIFY_SUPPLIERS: {
    capability: 'relay-deterministic',
    stage: 'QUALIFY',
    deterministicService: 'DeterministicQualificationService',
  },
  REQUEST_QUOTES: {
    capability: 'relay-deterministic',
    stage: 'QUOTE',
    deterministicService: 'RFQService',
  },
  INTERPRET_QUOTES: { capability: 'quote-interpreter', stage: 'QUOTE' },
  PLAN_NEGOTIATION: { capability: 'negotiation-strategist', stage: 'NEGOTIATE' },
  SELECT_SUPPLIER: {
    capability: 'relay-deterministic',
    stage: 'SELECT',
    deterministicService: 'QuoteSelectionService',
  },
  REQUEST_CLARIFICATION: { capability: 'relay-deterministic', stage: null, deterministicService: 'clarification-path' },
  WAIT_FOR_EXTERNAL_RESPONSE: { capability: 'relay-deterministic', stage: null, deterministicService: 'wait-state' },
  STOP_AUTONOMOUS_RUN: { capability: 'relay-deterministic', stage: null, deterministicService: 'stop-path' },
};

export const ROUTING_PRIORITIES = [
  'UNDERSTAND',
  'DISCOVER',
  'QUALIFY',
  'QUOTE',
  'NEGOTIATE',
  'SELECT',
  'CLARIFY',
  'WAIT',
  'STOP',
] as const;
export type RoutingPriority = (typeof ROUTING_PRIORITIES)[number];

export const ROUTING_ACTION_PRIORITY: Record<OrchestrationAction, RoutingPriority> = {
  UNDERSTAND_REQUEST: 'UNDERSTAND',
  PLAN_DISCOVERY: 'DISCOVER',
  QUALIFY_SUPPLIERS: 'QUALIFY',
  REQUEST_QUOTES: 'QUOTE',
  INTERPRET_QUOTES: 'QUOTE',
  PLAN_NEGOTIATION: 'NEGOTIATE',
  SELECT_SUPPLIER: 'SELECT',
  REQUEST_CLARIFICATION: 'CLARIFY',
  WAIT_FOR_EXTERNAL_RESPONSE: 'WAIT',
  STOP_AUTONOMOUS_RUN: 'STOP',
};

export const CONTEXT_VOCABULARY = [
  'verified-intent',
  'resolved-products',
  'quantities',
  'units',
  'deadline',
  'supplier-candidates',
  'qualified-suppliers',
  'received-quotes',
  'interpreted-quotes',
  'negotiation-state',
  'workflow-status',
  'policy-constraints',
  'community-demand',
] as const;

// Mirrors DeterministicNegotiationValidator guardrails.
const FORBIDDEN_PATTERN_PII =
  /\b(flat\s*\d+|tower\s*[a-z0-9]|res_[a-z0-9_]+|resident|apartment\s*\d+|mandate|budget\s*limit|spending\s*limit)\b/i;
const FORBIDDEN_PATTERN_AI =
  /\b(system\s*prompt|as\s*an?\s*ai|language\s*model|instructions\s*given)\b/i;

export function screenRoutingText(text: string): 'ok' | 'PRIVACY_VIOLATION' | 'PROMPT_LEAKAGE' {
  if (FORBIDDEN_PATTERN_PII.test(text)) return 'PRIVACY_VIOLATION';
  if (FORBIDDEN_PATTERN_AI.test(text)) return 'PROMPT_LEAKAGE';
  return 'ok';
}

const verifiedContextSchema = z
  .object({
    itemCount: z.number().int().min(0),
    quantities: z.array(z.number().finite().positive()),
    units: z.array(z.string().min(1).max(16)),
    deadlineHours: z.number().finite().positive().optional(),
  })
  .strict();

export const rawDecisionSchema = z
  .object({
    action: z.enum(ORCHESTRATION_ACTIONS),
    currentStage: z.string().min(1).max(32),
    targetStage: z.string().min(1).max(32),
    priority: z.enum(ROUTING_PRIORITIES),
    objective: z.string().min(1).max(500),
    rationale: z.string().min(1).max(1000),
    verifiedContext: verifiedContextSchema,
    requiredCapabilities: z.array(z.string().min(1).max(64)).max(10).optional(),
    requiredContext: z.array(z.string().min(1).max(64)).max(16).optional(),
    constraintsAcknowledged: z.array(z.string().min(1).max(120)).max(8).optional(),
    stopConditions: z.array(z.string().min(1).max(200)).min(1).max(5),
  })
  .strict();

export type RawRoutingDecision = z.infer<typeof rawDecisionSchema>;

/**
 * Inference-only tool definition for orchestration routing.
 * Deliberately NOT registered in the executable ToolRegistry.
 */
export const PLAN_NEXT_ACTION_TOOL: ToolDefinition = {
  name: ORCHESTRATION_TOOL_NAME,
  description:
    'Propose the next procurement capability for a verified workflow state. Call exactly once. Use these exact field names.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: `One of: ${(ORCHESTRATION_ACTIONS as readonly string[]).join(', ')}.`,
      },
      currentStage: { type: 'string', description: 'Copy exactly from context.' },
      targetStage: {
        type: 'string',
        description: 'One of the 13 Relay stages; must be a legal transition from currentStage.',
      },
      priority: {
        type: 'string',
        description: `One of: ${(ROUTING_PRIORITIES as readonly string[]).join(', ')}. Must match the action.`,
      },
      objective: { type: 'string' },
      rationale: { type: 'string' },
      verifiedContext: {
        type: 'object',
        description: 'Copy itemCount, quantities, units, and deadlineHours EXACTLY from context.',
        properties: {
          itemCount: { type: 'number' },
          quantities: { type: 'array', items: { type: 'number' } },
          units: { type: 'array', items: { type: 'string' } },
          deadlineHours: { type: 'number' },
        },
        required: ['itemCount', 'quantities', 'units'],
      },
      requiredCapabilities: { type: 'array', items: { type: 'string' } },
      requiredContext: { type: 'array', items: { type: 'string' } },
      constraintsAcknowledged: { type: 'array', items: { type: 'string' } },
      stopConditions: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'action',
      'currentStage',
      'targetStage',
      'priority',
      'objective',
      'rationale',
      'verifiedContext',
      'stopConditions',
    ],
  },
};

export const ORCHESTRATION_SYSTEM_PROMPT = [
  'You route autonomous procurement work for the Relay platform.',
  'You receive verified workflow context as JSON. You MUST call plan_next_procurement_action exactly once and MUST NOT reply in prose.',
  'Rules:',
  '1. action must be one of: UNDERSTAND_REQUEST, PLAN_DISCOVERY, QUALIFY_SUPPLIERS, REQUEST_QUOTES, INTERPRET_QUOTES, PLAN_NEGOTIATION, SELECT_SUPPLIER, REQUEST_CLARIFICATION, WAIT_FOR_EXTERNAL_RESPONSE, STOP_AUTONOMOUS_RUN. No other action exists. Never route to payment, fulfillment, allocation, reconciliation, or authorization.',
  '2. currentStage must be copied exactly from context. targetStage must be one of the 13 Relay stages (UNDERSTAND, DISCOVER, QUALIFY, QUOTE, NEGOTIATE, SELECT, COMMIT, PAY, FULFILL, VERIFY, ALLOCATE, RECONCILE, COMPLETE) and a legal forward step: UNDERSTAND_REQUEST targets UNDERSTAND; PLAN_DISCOVERY targets DISCOVER; QUALIFY_SUPPLIERS targets QUALIFY; REQUEST_QUOTES and INTERPRET_QUOTES target QUOTE; PLAN_NEGOTIATION targets NEGOTIATE; SELECT_SUPPLIER targets SELECT; clarification, waiting, and stop keep the current stage.',
  '3. priority must match the action: UNDERSTAND_REQUEST->UNDERSTAND, PLAN_DISCOVERY->DISCOVER, QUALIFY_SUPPLIERS->QUALIFY, REQUEST_QUOTES->QUOTE, INTERPRET_QUOTES->QUOTE, PLAN_NEGOTIATION->NEGOTIATE, SELECT_SUPPLIER->SELECT, REQUEST_CLARIFICATION->CLARIFY, WAIT_FOR_EXTERNAL_RESPONSE->WAIT, STOP_AUTONOMOUS_RUN->STOP.',
  '4. verifiedContext (itemCount, quantities, units, deadlineHours) must be copied EXACTLY from context. Never change, merge, drop, or invent products, quantities, units, or deadlines.',
  '5. Prefer forward progress when preconditions hold: unresolved intent -> UNDERSTAND_REQUEST; resolved intent at UNDERSTAND -> PLAN_DISCOVERY; discovered suppliers -> QUALIFY_SUPPLIERS; qualified suppliers -> REQUEST_QUOTES; pending raw responses -> INTERPRET_QUOTES; eligible negotiation -> PLAN_NEGOTIATION; verified quotes without negotiation -> SELECT_SUPPLIER.',
  '6. Use REQUEST_CLARIFICATION for ambiguous or missing information, WAIT_FOR_EXTERNAL_RESPONSE when legitimately awaiting supplier events, and STOP_AUTONOMOUS_RUN when blockers, terminal failures, or policy prevent continuation.',
  '7. requiredCapabilities may only name actions from rule 1. requiredContext may only name: verified-intent, resolved-products, quantities, units, deadline, supplier-candidates, qualified-suppliers, received-quotes, interpreted-quotes, negotiation-state, workflow-status, policy-constraints, community-demand.',
  '8. State at least one stop condition protecting verified hard constraints. NEVER output supplier identities, prices, availability, payment amounts, recipients, fulfillment state, allocation, reconciliation values, authorization claims, tool names outside rule 1, endpoints, or code. Never include resident PII or budget data in any text.',
].join('\n');
