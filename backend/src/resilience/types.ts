import {
  WorkflowStage,
  WorkflowStatus,
} from '../orchestration/types';

/**
 * Standardized, deterministic failure categories across Relay.
 */
export type FailureCategory =
  | 'RETRYABLE'
  | 'NON_RETRYABLE'
  | 'WAITING'
  | 'USER_ACTION_REQUIRED'
  | 'SYSTEM_BLOCKED';

/**
 * Deterministic failure classification model.
 * Never determined probabilistically by an LLM.
 */
export interface FailureClassification {
  category: FailureCategory;
  retryable: boolean;
  safeToRetry: boolean;
  requiresUserAction: boolean;
  canContinue: boolean;
  reason: string;
  recoveryAction: string;
  errorType?: string;
  httpStatus?: number;
  details?: Record<string, unknown>;
}

/**
 * Operational retry configuration policy.
 */
export interface RetryPolicy {
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  backoffMultiplier: number;
  jitter: boolean;
  timeoutMs: number;
  requiresAuthoritativeCheck: boolean;
}

/**
 * Bounded exponential backoff calculation result.
 */
export interface BackoffResult {
  attempt: number;
  backoffMs: number;
  jitterMs: number;
  totalDelayMs: number;
}

/**
 * High-level recovery action decided by the deterministic recovery engine.
 */
export type RecoveryAction =
  | 'RESUME_CHECKPOINT'
  | 'RETRY_STAGE'
  | 'ADVANCE_STAGE'
  | 'ENTER_SAFE_STATE'
  | 'TERMINATE'
  | 'NONE';

/**
 * Deterministic recovery evaluation decision.
 */
export interface RecoveryDecision {
  action: RecoveryAction;
  canRecover: boolean;
  canResume: boolean;
  targetStage: WorkflowStage;
  targetStatus: WorkflowStatus;
  classification: FailureCategory;
  reason: string;
  skipPaymentReExecution?: boolean;
  isPaymentExecuted?: boolean;
  safeState?: 'WAITING' | 'USER_ACTION_REQUIRED' | 'SYSTEM_BLOCKED' | 'FAILED';
  suggestedUserAction?: string;
}

/**
 * Persistent idempotency cache record.
 */
export interface IdempotencyRecord<T = unknown> {
  key: string;
  status: 'IN_FLIGHT' | 'COMPLETED' | 'FAILED';
  result?: T;
  error?: string;
  resourceId?: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

/**
 * Operational concurrency lock representation.
 */
export interface ConcurrencyLock {
  lockId: string;
  resourceKey: string;
  owner: string;
  acquiredAt: Date;
  expiresAt: Date;
}

/**
 * Stale workflow evaluation result.
 */
export interface StaleWorkflowEvaluation {
  workflowId: string;
  isStale: boolean;
  ageSeconds: number;
  idleSeconds: number;
  stage: WorkflowStage;
  status: WorkflowStatus;
  thresholdSeconds: number;
  recommendedAction: RecoveryAction;
  reason: string;
}
