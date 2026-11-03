import { WorkflowStage } from '../../orchestration/types';

/**
 * Phase 16 — AI execution adapter contract types.
 *
 * The adapter sits between the deterministic workflow engine and the Phase
 * 14/15 AI modules. Every method is total: model-data failures become typed
 * failure envelopes (FAIL_CLOSED), never throws, never partial mutations.
 */

export type AdapterFailureCode =
  | 'MODEL_TIMEOUT'
  | 'MALFORMED_RESPONSE'
  | 'NO_TOOL_CALL'
  | 'SCHEMA_VIOLATION'
  | 'VALIDATION_FAILED'
  | 'UNMAPPABLE_PRODUCT'
  | 'DISCOVERY_FAILED'
  | 'NO_CANDIDATES'
  | 'INTERPRETATION_FAILED'
  | 'NO_USABLE_LINES'
  | 'NEGOTIATION_FAILED'
  | 'ROUTING_FAILED'
  | 'PROVIDER_ERROR'
  | 'ADAPTER_ERROR';

export interface AdapterFailure {
  code: AdapterFailureCode;
  message: string;
  stage: WorkflowStage;
  retryable: boolean;
  underlyingCode?: string;
}

export interface StageEvidence {
  stage: WorkflowStage;
  capability: string;
  summary: string;
  details: Record<string, unknown>;
}

export type AdapterResult<T> =
  | { ok: true; value: T; evidence: StageEvidence }
  | { ok: false; failure: AdapterFailure };
