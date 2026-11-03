import { WorkflowStage } from '../orchestration/types';
import { FailureClassification, RetryPolicy } from './types';

export class RetryPolicyService {
  private stagePolicies = new Map<WorkflowStage, RetryPolicy>();

  constructor() {
    this.registerDefaultPolicies();
  }

  private registerDefaultPolicies(): void {
    // Stage 1: UNDERSTAND (Deterministic syntax, 1 attempt)
    this.stagePolicies.set('UNDERSTAND', {
      maxAttempts: 1,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      backoffMultiplier: 1,
      jitter: false,
      timeoutMs: 5000,
      requiresAuthoritativeCheck: false,
    });

    // Stage 2: DISCOVER (External Geoapify Places API, 3 attempts)
    this.stagePolicies.set('DISCOVER', {
      maxAttempts: 3,
      initialBackoffMs: 500,
      maxBackoffMs: 5000,
      backoffMultiplier: 2.0,
      jitter: true,
      timeoutMs: 10000,
      requiresAuthoritativeCheck: false,
    });

    // Stage 3: QUALIFY (Deterministic rule engine, 1 attempt)
    this.stagePolicies.set('QUALIFY', {
      maxAttempts: 1,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      backoffMultiplier: 1,
      jitter: false,
      timeoutMs: 5000,
      requiresAuthoritativeCheck: false,
    });

    // Stage 4: QUOTE (External RFQ transport / Resend, 3 attempts)
    this.stagePolicies.set('QUOTE', {
      maxAttempts: 3,
      initialBackoffMs: 1000,
      maxBackoffMs: 8000,
      backoffMultiplier: 2.0,
      jitter: true,
      timeoutMs: 15000,
      requiresAuthoritativeCheck: false,
    });

    // Stage 5: NEGOTIATE (Multi-round counteroffers, 2 attempts per round)
    this.stagePolicies.set('NEGOTIATE', {
      maxAttempts: 2,
      initialBackoffMs: 1000,
      maxBackoffMs: 5000,
      backoffMultiplier: 1.5,
      jitter: true,
      timeoutMs: 10000,
      requiresAuthoritativeCheck: false,
    });

    // Stage 6: SELECT (Deterministic selection validator, 1 attempt)
    this.stagePolicies.set('SELECT', {
      maxAttempts: 1,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      backoffMultiplier: 1,
      jitter: false,
      timeoutMs: 5000,
      requiresAuthoritativeCheck: false,
    });

    // Stage 7: COMMIT (Commitment creation, 2 attempts)
    this.stagePolicies.set('COMMIT', {
      maxAttempts: 2,
      initialBackoffMs: 500,
      maxBackoffMs: 3000,
      backoffMultiplier: 2.0,
      jitter: true,
      timeoutMs: 8000,
      requiresAuthoritativeCheck: false,
    });

    // Stage 8: PAY (Financial Execution - STRICT 2 attempts, MANDATORY authoritative status check)
    this.stagePolicies.set('PAY', {
      maxAttempts: 2,
      initialBackoffMs: 2000,
      maxBackoffMs: 10000,
      backoffMultiplier: 2.0,
      jitter: true,
      timeoutMs: 20000,
      requiresAuthoritativeCheck: true, // Non-negotiable financial safeguard
    });

    // Stage 9: FULFILL (Carrier dispatch / milestone tracking, 3 attempts)
    this.stagePolicies.set('FULFILL', {
      maxAttempts: 3,
      initialBackoffMs: 1000,
      maxBackoffMs: 10000,
      backoffMultiplier: 2.0,
      jitter: true,
      timeoutMs: 15000,
      requiresAuthoritativeCheck: false,
    });

    // Stage 10: VERIFY (Evidence inspection, 2 attempts)
    this.stagePolicies.set('VERIFY', {
      maxAttempts: 2,
      initialBackoffMs: 500,
      maxBackoffMs: 3000,
      backoffMultiplier: 2.0,
      jitter: false,
      timeoutMs: 8000,
      requiresAuthoritativeCheck: false,
    });

    // Stage 11: ALLOCATE (Deterministic allocation arithmetic, 2 attempts)
    this.stagePolicies.set('ALLOCATE', {
      maxAttempts: 2,
      initialBackoffMs: 500,
      maxBackoffMs: 3000,
      backoffMultiplier: 2.0,
      jitter: false,
      timeoutMs: 8000,
      requiresAuthoritativeCheck: false,
    });

    // Stage 12: RECONCILE (4-Pillar conservation check, 1 attempt - discrepancies halt safely)
    this.stagePolicies.set('RECONCILE', {
      maxAttempts: 1,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      backoffMultiplier: 1,
      jitter: false,
      timeoutMs: 5000,
      requiresAuthoritativeCheck: false,
    });

    // Stage 13: COMPLETE (Terminal invariant validation, 1 attempt)
    this.stagePolicies.set('COMPLETE', {
      maxAttempts: 1,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      backoffMultiplier: 1,
      jitter: false,
      timeoutMs: 5000,
      requiresAuthoritativeCheck: false,
    });
  }

  public getPolicy(stage: WorkflowStage): RetryPolicy {
    return (
      this.stagePolicies.get(stage) || {
        maxAttempts: 2,
        initialBackoffMs: 1000,
        maxBackoffMs: 5000,
        backoffMultiplier: 2.0,
        jitter: true,
        timeoutMs: 10000,
        requiresAuthoritativeCheck: false,
      }
    );
  }

  public setPolicy(stage: WorkflowStage, policy: RetryPolicy): void {
    this.stagePolicies.set(stage, policy);
  }

  public canRetry(
    stage: WorkflowStage,
    currentAttempt: number,
    classification: FailureClassification,
    isAuthoritativeStateChecked = false
  ): { allowed: boolean; reason: string } {
    return this.shouldRetry(stage, currentAttempt, classification, isAuthoritativeStateChecked);
  }

  /**
   * Deterministically evaluates whether a retry is permitted.
   */
  public shouldRetry(
    stage: WorkflowStage,
    currentAttempt: number,
    classification: FailureClassification,
    isAuthoritativeStateChecked = false
  ): { allowed: boolean; reason: string } {
    const policy = this.getPolicy(stage);

    if (currentAttempt >= policy.maxAttempts) {
      return {
        allowed: false,
        reason: `MAX_ATTEMPTS_EXCEEDED: Reached maximum ${policy.maxAttempts} retry attempts for stage ${stage}`,
      };
    }

    if (!classification.retryable) {
      return {
        allowed: false,
        reason: `NON_RETRYABLE_ERROR: Failure category is ${classification.category} (${classification.reason})`,
      };
    }

    if (policy.requiresAuthoritativeCheck && !isAuthoritativeStateChecked) {
      return {
        allowed: false,
        reason: `AUTHORITATIVE_CHECK_REQUIRED: Stage ${stage} requires verified authoritative backend status check before retry`,
      };
    }

    return {
      allowed: true,
      reason: `RETRY_PERMITTED: Attempt ${currentAttempt + 1} of ${policy.maxAttempts} allowed under policy`,
    };
  }
}

export const retryPolicyService = new RetryPolicyService();
