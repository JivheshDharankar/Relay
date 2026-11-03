import { WorkflowStage } from '../orchestration/types';
import { FailureClassification } from './types';

/**
 * Deterministic Failure Classification Service.
 * Implements authoritative error taxonomy and safe retry determination.
 * Never probabilistic; strictly auditable and explainable.
 */
export class FailureClassificationService {
  /**
   * Classifies an arbitrary runtime error or exception within its operational context.
   */
  public classify(
    error: unknown,
    context?: {
      stage?: WorkflowStage;
      operation?: string;
      isPaymentOperation?: boolean;
      httpStatus?: number;
    }
  ): FailureClassification {
    const message = this.extractMessage(error);
    const upperMessage = message.toUpperCase();
    const errorType = (error as any)?.name || (error as any)?.constructor?.name || 'Error';

    let httpStatus =
      context?.httpStatus ??
      (error as any)?.status ??
      (error as any)?.httpStatus ??
      (error as any)?.response?.status ??
      (error as any)?.statusCode;

    if (!httpStatus) {
      const match = message.match(/\b(400|401|403|404|429|500|502|503|504)\b/);
      if (match) {
        httpStatus = parseInt(match[1], 10);
      }
    }

    // -------------------------------------------------------------------------
    // 1. SYSTEM_BLOCKED: Unresolvable authoritative uncertainty or financial discrepancy
    // -------------------------------------------------------------------------
    if (
      upperMessage.includes('RECONCILIATION_DISCREPANCY') ||
      upperMessage.includes('RECONCILIATION_ARITHMETIC_MISMATCH') ||
      upperMessage.includes('DISCREPANCY_DETECTED') ||
      upperMessage.includes('INCONSISTENT_FINANCIAL') ||
      upperMessage.includes('CORRUPTED_CHECKPOINT') ||
      upperMessage.includes('CORRUPTED_WORKFLOW') ||
      upperMessage.includes('AUTHORITATIVE_STATE_UNKNOWN') ||
      upperMessage.includes('SYSTEM_BLOCKED')
    ) {
      return {
        category: 'SYSTEM_BLOCKED',
        retryable: false,
        safeToRetry: false,
        requiresUserAction: false,
        canContinue: false,
        reason: message,
        recoveryAction: 'HALT_FOR_MANUAL_AUDIT',
        errorType,
        httpStatus,
      };
    }

    // -------------------------------------------------------------------------
    // 2. USER_ACTION_REQUIRED: Clarification, ambiguity, or mandate limits
    // -------------------------------------------------------------------------
    if (
      upperMessage.includes('AWAITING_CLARIFICATION') ||
      upperMessage.includes('AMBIGUOUS_INTENT') ||
      upperMessage.includes('AMBIGUOUS_DEMAND') ||
      upperMessage.includes('AMBIGUOUS') ||
      upperMessage.includes('CLARIFICATION_REQUIRED') ||
      upperMessage.includes('REQUEST_USER_CLARIFICATION') ||
      upperMessage.includes('MANDATE_CAPACITY_EXCEEDED') ||
      upperMessage.includes('MANDATE_LIMIT_EXCEEDED') ||
      upperMessage.includes('INSUFFICIENT_MANDATE_CAPACITY') ||
      upperMessage.includes('INSUFFICIENT_FUNDS') ||
      upperMessage.includes('PAYMENT_DECLINED') ||
      upperMessage.includes('USER_ACTION_REQUIRED') ||
      upperMessage.includes('CONFIRMATION_REQUIRED')
    ) {
      return {
        category: 'USER_ACTION_REQUIRED',
        retryable: false,
        safeToRetry: false,
        requiresUserAction: true,
        canContinue: false,
        reason: message,
        recoveryAction: upperMessage.includes('AMBIGUOUS')
          ? 'REQUEST_USER_CLARIFICATION'
          : 'REQUEST_USER_INPUT: Await resident decision or mandate increase',
        errorType,
        httpStatus,
      };
    }

    // -------------------------------------------------------------------------
    // 3. WAITING: Operational in-transit or pending external response (NOT a failure)
    // -------------------------------------------------------------------------
    if (
      upperMessage.includes('WAITING_FOR_QUOTES') ||
      upperMessage.includes('AWAITING_SUPPLIER_RESPONSE') ||
      upperMessage.includes('QUOTE_PENDING') ||
      upperMessage.includes('DELIVERY_IN_TRANSIT') ||
      upperMessage.includes('IN_TRANSIT') ||
      upperMessage.includes('PENDING_EXTERNAL_CONFIRMATION') ||
      upperMessage.includes('WAITING')
    ) {
      return {
        category: 'WAITING',
        retryable: false,
        safeToRetry: false,
        requiresUserAction: false,
        canContinue: false,
        reason: message,
        recoveryAction: 'WAIT_FOR_EXTERNAL_EVENT',
        errorType,
        httpStatus,
      };
    }

    // -------------------------------------------------------------------------
    // 4. NON_RETRYABLE: Business invariant violations, invalid inputs, invalid transitions
    // -------------------------------------------------------------------------
    const isExplicitClientError = httpStatus && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429;
    const isExplicitNonRetryable =
      isExplicitClientError ||
      upperMessage.includes('INVALID_COORDINATES') ||
      upperMessage.includes('INVALID_LATITUDE') ||
      upperMessage.includes('INVALID_LONGITUDE') ||
      upperMessage.includes('INVALID_QUANTITY') ||
      upperMessage.includes('INVALID_UNIT') ||
      upperMessage.includes('EMPTY_REQUEST') ||
      upperMessage.includes('CANDIDATE_REJECTED') ||
      upperMessage.includes('SUPPLIER_REJECTION') ||
      upperMessage.includes('NO_QUALIFIED_SUPPLIERS') ||
      upperMessage.includes('MALFORMED_QUOTE') ||
      upperMessage.includes('INVALID_QUOTE') ||
      upperMessage.includes('EXPIRED_QUOTE') ||
      upperMessage.includes('UNAUTHORIZED_RESIDENT') ||
      upperMessage.includes('FAKE_SUPPLIER') ||
      upperMessage.includes('FAKE_QUOTE') ||
      upperMessage.includes('MISSING_PRECONDITION') ||
      upperMessage.includes('PRIVACY_VIOLATION') ||
      upperMessage.includes('NON_RETRYABLE') ||
      upperMessage.includes('INVALID STATE MACHINE TRANSITION') ||
      upperMessage.includes('ILLEGAL WORKFLOW TRANSITION') ||
      upperMessage.includes('WORKFLOWSTATEMACHINEERROR') ||
      error instanceof SyntaxError ||
      errorType === 'SyntaxError' ||
      errorType === 'WorkflowStateMachineError' ||
      errorType === 'SelectionValidationError' ||
      errorType === 'AllocationValidationError';

    if (isExplicitNonRetryable) {
      return {
        category: 'NON_RETRYABLE',
        retryable: false,
        safeToRetry: false,
        requiresUserAction: false,
        canContinue: false,
        reason: message,
        recoveryAction: 'TERMINATE_OR_REJECT: Input or state violates non-negotiable domain rules',
        errorType,
        httpStatus,
      };
    }

    // -------------------------------------------------------------------------
    // 5. RETRYABLE: Transient network errors, timeouts, rate limits, 500s
    // -------------------------------------------------------------------------
    const isTransientNetwork =
      upperMessage.includes('TIMEOUT') ||
      upperMessage.includes('NETWORK') ||
      upperMessage.includes('ETIMEDOUT') ||
      upperMessage.includes('ECONNRESET') ||
      upperMessage.includes('ECONNREFUSED') ||
      upperMessage.includes('ENOTFOUND') ||
      upperMessage.includes('EAI_AGAIN') ||
      upperMessage.includes('NETWORK_TIMEOUT') ||
      upperMessage.includes('NETWORK_ERROR') ||
      upperMessage.includes('GATEWAY') ||
      upperMessage.includes('RATE_LIMIT') ||
      upperMessage.includes('RATE LIMIT') ||
      upperMessage.includes('TOO MANY REQUESTS') ||
      upperMessage.includes('SERVICE UNAVAILABLE') ||
      httpStatus === 429 ||
      httpStatus === 500 ||
      httpStatus === 502 ||
      httpStatus === 503 ||
      httpStatus === 504;

    if (isTransientNetwork) {
      const isPayment =
        context?.isPaymentOperation ||
        context?.stage === 'PAY' ||
        upperMessage.includes('PAYMENT');

      // CRITICAL INVARIANT: For payments, a timeout or network loss means payment
      // state is UNKNOWN. It is RETRYABLE only after authoritative state check!
      const safeToRetry = !isPayment;

      let recoveryAction = 'RETRY_WITH_BACKOFF';
      if (isPayment) {
        recoveryAction = 'INSPECT_AUTHORITATIVE_STATE_BEFORE_RETRY';
      } else if (httpStatus === 429 || upperMessage.includes('RATE')) {
        recoveryAction = 'BACKOFF_AND_RETRY';
      }

      return {
        category: 'RETRYABLE',
        retryable: true,
        safeToRetry,
        requiresUserAction: false,
        canContinue: true,
        reason: message,
        recoveryAction,
        errorType,
        httpStatus,
      };
    }

    // Default fallback: Fail-safe to NON_RETRYABLE to prevent dangerous infinite retry loops
    return {
      category: 'NON_RETRYABLE',
      retryable: false,
      safeToRetry: false,
      requiresUserAction: false,
      canContinue: false,
      reason: message || 'Unknown operational failure',
      recoveryAction: 'INVESTIGATE_UNKNOWN_FAILURE: Unknown error must not be blindly retried',
      errorType,
      httpStatus,
    };
  }

  private extractMessage(error: unknown): string {
    if (!error) return 'Empty error';
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message;
    if (typeof error === 'object') {
      if ('message' in error && typeof (error as any).message === 'string') {
        return (error as any).message;
      }
      if ((error as any).response?.data) {
        if (typeof (error as any).response.data === 'string') {
          return (error as any).response.data;
        }
        if ((error as any).response.data.message) {
          return String((error as any).response.data.message);
        }
      }
      if ((error as any).response?.statusText) {
        return String((error as any).response.statusText);
      }
      if ((error as any).statusText) {
        return String((error as any).statusText);
      }
    }
    return String(error);
  }
}

export const failureClassificationService = new FailureClassificationService();
