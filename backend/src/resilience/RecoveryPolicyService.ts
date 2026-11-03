import { paymentService, PaymentService } from '../payment';
import { fulfillmentService, FulfillmentService } from '../fulfillment';
import { allocationService, AllocationService } from '../allocation';
import { reconciliationService, ReconciliationService } from '../allocation/ReconciliationService';
import { RelayWorkflow, WorkflowCheckpoint } from '../orchestration/types';
import {
  FailureClassificationService,
  failureClassificationService,
} from './FailureClassificationService';
import { RetryPolicyService, retryPolicyService } from './RetryPolicyService';
import { RecoveryDecision } from './types';

export class RecoveryPolicyService {
  constructor(
    private readonly classificationSvc: FailureClassificationService = failureClassificationService,
    private readonly retryPolicySvc: RetryPolicyService = retryPolicyService,
    private readonly paymentSvc: PaymentService = paymentService,
    private readonly fulfillmentSvc: FulfillmentService = fulfillmentService,
    private readonly allocationSvc: AllocationService = allocationService,
    private readonly reconciliationSvc: ReconciliationService = reconciliationService
  ) {}

  /**
   * Deterministically evaluates whether an interrupted, failed, or ambiguous workflow can recover,
   * what state it should transition into, and whether financial/state re-executions must be prevented.
   *
   * Principle: The deterministic backend is authoritative. AI never decides whether money was paid
   * or whether payment can safely be retried.
   */
  public evaluateRecovery(
    workflow: RelayWorkflow,
    error?: unknown,
    checkpoint?: WorkflowCheckpoint
  ): RecoveryDecision {
    // 1. Terminal states cannot be recovered
    if (workflow.status === 'COMPLETED') {
      return {
        action: 'NONE',
        canRecover: false,
        canResume: false,
        targetStage: 'COMPLETE',
        targetStatus: 'COMPLETED',
        classification: 'NON_RETRYABLE',
        reason: 'Workflow is in terminal COMPLETED status; no recovery required',
      };
    }

    if (workflow.status === 'CANCELLED') {
      return {
        action: 'TERMINATE',
        canRecover: false,
        canResume: false,
        targetStage: workflow.currentStage,
        targetStatus: 'CANCELLED',
        classification: 'NON_RETRYABLE',
        reason: 'Workflow was cancelled by user or system',
      };
    }

    // 2. Authoritative Payment Inspection (Never blindly retry or double charge)
    if (workflow.entities.commitmentId) {
      try {
        const paymentSummary = this.paymentSvc.getProcurementPaymentSummary(
          workflow.entities.commitmentId
        );

        if (paymentSummary.status === 'FULLY_PAID') {
          return {
            action: 'ADVANCE_STAGE',
            canRecover: true,
            canResume: true,
            skipPaymentReExecution: true,
            isPaymentExecuted: true,
            targetStage: 'FULFILL',
            targetStatus: 'FULFILLING',
            classification: 'RETRYABLE',
            reason:
              'PAYMENT_ALREADY_SUCCEEDED: Commitment payment verified on authoritative ledger. Advancing safely to fulfillment without double charge.',
          };
        }

        if (paymentSummary.status === 'PROCESSING') {
          return {
            action: 'ENTER_SAFE_STATE',
            canRecover: false,
            canResume: false,
            targetStage: 'PAY',
            targetStatus: 'EXECUTING_PAYMENT',
            classification: 'WAITING',
            safeState: 'WAITING',
            reason:
              'PAYMENT_IN_FLIGHT_UNKNOWN: Payment is currently processing with provider. Awaiting authoritative webhook or provider confirmation before any retry.',
          };
        }
      } catch {
        // Commitment not found or not in payment yet, continue evaluation
      }
    }

    // Direct single payment inspection if paymentId is attached
    if (workflow.entities.paymentId) {
      const payment = this.paymentSvc.getPayment(workflow.entities.paymentId);
      if (payment) {
        if (payment.status === 'SUCCEEDED') {
          return {
            action: 'ADVANCE_STAGE',
            canRecover: true,
            canResume: true,
            skipPaymentReExecution: true,
            isPaymentExecuted: true,
            targetStage: 'FULFILL',
            targetStatus: 'FULFILLING',
            classification: 'RETRYABLE',
            reason:
              'PAYMENT_ALREADY_SUCCEEDED: Payment verified. Advancing directly to fulfillment.',
          };
        }

        if (payment.status === 'PROCESSING' || payment.status === 'AUTHORIZED') {
          return {
            action: 'ENTER_SAFE_STATE',
            canRecover: false,
            canResume: false,
            targetStage: 'PAY',
            targetStatus: 'EXECUTING_PAYMENT',
            classification: 'WAITING',
            safeState: 'WAITING',
            reason:
              'PAYMENT_IN_FLIGHT_UNKNOWN: Payment obligation is processing. Never retry blindly.',
          };
        }
      }
    }

    // 3. Authoritative Fulfillment Inspection
    if (workflow.entities.fulfillmentOrderIds && workflow.entities.fulfillmentOrderIds.length > 0) {
      try {
        const orders = workflow.entities.fulfillmentOrderIds
          .map((id) => this.fulfillmentSvc.getFulfillment(id))
          .filter((f): f is NonNullable<typeof f> => Boolean(f));

        if (orders.length > 0 && orders.every((o) => o.status === 'VERIFIED')) {
          return {
            action: 'ADVANCE_STAGE',
            canRecover: true,
            canResume: true,
            targetStage: 'ALLOCATE',
            targetStatus: 'ALLOCATING_RESIDENT_DEMAND',
            classification: 'RETRYABLE',
            reason:
              'FULFILLMENT_ALREADY_VERIFIED: All fulfillments verified. Advancing to resident allocation.',
          };
        }
      } catch {
        // Fall through
      }
    }

    // 4. Authoritative Resident Allocation Inspection
    if (workflow.entities.commitmentId) {
      try {
        const summary = this.allocationSvc.getCommitmentAllocationSummary(
          workflow.entities.commitmentId
        );
        if (summary && summary.status === 'FINALIZED') {
          return {
            action: 'ADVANCE_STAGE',
            canRecover: true,
            canResume: true,
            targetStage: 'RECONCILE',
            targetStatus: 'RECONCILING',
            classification: 'RETRYABLE',
            reason:
              'ALLOCATION_ALREADY_FINALIZED: Allocation finalized. Advancing to reconciliation.',
          };
        }
      } catch {
        // Fall through
      }
    }

    // 5. Authoritative Reconciliation Inspection
    if (workflow.entities.commitmentId) {
      try {
        const reconciliation = this.reconciliationSvc.getReconciliationResult(
          workflow.entities.commitmentId
        );
        if (reconciliation) {
          if (reconciliation.status === 'RECONCILED') {
            return {
              action: 'ADVANCE_STAGE',
              canRecover: true,
              canResume: true,
              targetStage: 'COMPLETE',
              targetStatus: 'COMPLETED',
              classification: 'RETRYABLE',
              reason:
                'RECONCILIATION_ALREADY_RECONCILED: Financial records fully reconciled. Workflow ready to complete.',
            };
          }

          if (reconciliation.status === 'DISCREPANCY' || reconciliation.status === 'BLOCKED') {
            return {
              action: 'ENTER_SAFE_STATE',
              canRecover: false,
              canResume: false,
              targetStage: 'RECONCILE',
              targetStatus: 'FAILED',
              classification: 'SYSTEM_BLOCKED',
              safeState: 'SYSTEM_BLOCKED',
              reason: `RECONCILIATION_DISCREPANCY: Reconcile status is '${reconciliation.status}' with ${reconciliation.discrepancies.length} discrepancies. System halted for human review.`,
            };
          }
        }
      } catch {
        // Fall through
      }
    }

    // 6. Stage-Specific Policy & Retry Exhaustion Check
    const stagePolicy = this.retryPolicySvc.getPolicy(workflow.currentStage);
    if (workflow.retryCount >= stagePolicy.maxAttempts) {
      return {
        action: 'ENTER_SAFE_STATE',
        canRecover: false,
        canResume: false,
        targetStage: workflow.currentStage,
        targetStatus: 'FAILED',
        classification: 'NON_RETRYABLE',
        safeState: 'FAILED',
        reason: `MAX_RETRIES_EXCEEDED: Exhausted all ${stagePolicy.maxAttempts} attempts for stage '${workflow.currentStage}'`,
      };
    }

    // 7. Resumption of active / interrupted workflow without explicit error
    if (!error && !workflow.failureReason && workflow.status !== 'FAILED') {
      const targetStage = checkpoint ? checkpoint.stage : workflow.currentStage;
      const targetStatus = checkpoint ? checkpoint.status : workflow.status;

      return {
        action: checkpoint ? 'RESUME_CHECKPOINT' : 'RETRY_STAGE',
        canRecover: true,
        canResume: true,
        targetStage,
        targetStatus,
        classification: 'RETRYABLE',
        reason: checkpoint
          ? 'CHECKPOINT_RESUMPTION: Workflow state restored successfully from last valid checkpoint'
          : 'STAGE_RESUMPTION: Resuming active workflow from current stage',
      };
    }

    // 8. Deterministic Classification of Error
    const rawError = error || workflow.failureReason || 'Unknown error occurred';
    const classification = this.classificationSvc.classify(rawError, {
      stage: workflow.currentStage,
      isPaymentOperation: workflow.currentStage === 'PAY',
    });

    switch (classification.category) {
      case 'USER_ACTION_REQUIRED':
        return {
          action: 'ENTER_SAFE_STATE',
          canRecover: false,
          canResume: false,
          targetStage: workflow.currentStage,
          targetStatus: workflow.status,
          classification: 'USER_ACTION_REQUIRED',
          safeState: 'USER_ACTION_REQUIRED',
          suggestedUserAction: classification.recoveryAction,
          reason: classification.reason,
        };

      case 'SYSTEM_BLOCKED':
        return {
          action: 'ENTER_SAFE_STATE',
          canRecover: false,
          canResume: false,
          targetStage: workflow.currentStage,
          targetStatus: 'FAILED',
          classification: 'SYSTEM_BLOCKED',
          safeState: 'SYSTEM_BLOCKED',
          reason: classification.reason,
        };

      case 'WAITING':
        return {
          action: 'ENTER_SAFE_STATE',
          canRecover: false,
          canResume: false,
          targetStage: workflow.currentStage,
          targetStatus: workflow.status,
          classification: 'WAITING',
          safeState: 'WAITING',
          reason: classification.reason,
        };

      case 'NON_RETRYABLE':
        return {
          action: 'TERMINATE',
          canRecover: false,
          canResume: false,
          targetStage: workflow.currentStage,
          targetStatus: 'FAILED',
          classification: 'NON_RETRYABLE',
          safeState: 'FAILED',
          reason: classification.reason,
        };

      case 'RETRYABLE':
      default: {
        // Safe to retry or resume from checkpoint
        const targetStage = checkpoint ? checkpoint.stage : workflow.currentStage;
        const targetStatus = checkpoint ? checkpoint.status : workflow.status;

        return {
          action: checkpoint ? 'RESUME_CHECKPOINT' : 'RETRY_STAGE',
          canRecover: true,
          canResume: true,
          targetStage,
          targetStatus,
          classification: 'RETRYABLE',
          reason: `RETRYABLE_STAGE: ${classification.reason}`,
        };
      }
    }
  }
}

export const recoveryPolicyService = new RecoveryPolicyService();
