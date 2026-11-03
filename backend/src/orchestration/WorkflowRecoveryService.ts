import { paymentService } from '../payment';
import { fulfillmentService } from '../fulfillment';
import { allocationService } from '../allocation';
import { WorkflowCheckpointService, workflowCheckpointService } from './WorkflowCheckpointService';
import { WorkflowEventService, workflowEventService } from './WorkflowEventService';
import {
  FailureClassification,
  RelayWorkflow,
  WorkflowStage,
  WorkflowStatus,
} from './types';
import {
  moveWorkflowStageForRecovery,
  resetWorkflowStagesAfter,
  transitionWorkflowStatus,
} from './stateMachine';

export interface RecoveryEvaluation {
  canResume: boolean;
  canRecover: boolean;
  recommendedAction: 'NONE' | 'RETRY_STAGE' | 'RESUME_CHECKPOINT' | 'ADVANCE_STAGE';
  isPaymentExecuted?: boolean;
  resumeStage: WorkflowStage;
  targetStatus: WorkflowStatus;
  classification: FailureClassification;
  reason: string;
}

export class WorkflowRecoveryService {
  constructor(
    private readonly checkpointService: WorkflowCheckpointService = workflowCheckpointService,
    private readonly eventService: WorkflowEventService = workflowEventService
  ) {}

  /**
   * Deterministically evaluates whether an interrupted, failed, or stale workflow can resume.
   * Inspects authoritative backend state (payments, fulfillments, allocations) before attempting continuation.
   */
  public evaluateRecovery(workflow: RelayWorkflow): RecoveryEvaluation {
    if (workflow.status === 'COMPLETED') {
      return {
        canResume: false,
        canRecover: false,
        recommendedAction: 'NONE',
        resumeStage: 'COMPLETE',
        targetStatus: 'COMPLETED',
        classification: 'NON_RETRYABLE',
        reason: 'Workflow is in terminal COMPLETED status; no recovery required',
      };
    }

    if (workflow.status === 'CANCELLED') {
      return {
        canResume: false,
        canRecover: false,
        recommendedAction: 'NONE',
        resumeStage: workflow.currentStage,
        targetStatus: 'CANCELLED',
        classification: 'NON_RETRYABLE',
        reason: 'Workflow was cancelled by user or system',
      };
    }

    // A clarification-paused workflow resumes by re-running understand on the
    // (possibly amended) request — never by regressing to a stale checkpoint.
    if (workflow.status === 'AWAITING_CLARIFICATION') {
      return {
        canResume: true,
        canRecover: true,
        recommendedAction: 'RETRY_STAGE',
        resumeStage: 'UNDERSTAND',
        targetStatus: 'UNDERSTANDING',
        classification: 'RETRYABLE',
        reason: 'AWAITING_CLARIFICATION: Re-running understanding on the current request text',
      };
    }

    const latestCheckpoint = this.checkpointService.getLatestCheckpoint(workflow.id);

    // Inspect authoritative payment state to prevent double payment
    if (workflow.entities.paymentId) {
      const payment = paymentService.getPayment(workflow.entities.paymentId);
      if (payment && payment.status === 'SUCCEEDED') {
        return {
          canResume: true,
          canRecover: true,
          isPaymentExecuted: true,
          recommendedAction: 'ADVANCE_STAGE',
          resumeStage: 'FULFILL',
          targetStatus: 'FULFILLING',
          classification: 'RETRYABLE',
          reason: 'PAYMENT_ALREADY_SUCCEEDED: Resuming from fulfillment creation safely without double charge',
        };
      }
    }

    // Inspect authoritative fulfillment state
    if (workflow.entities.fulfillmentOrderIds && workflow.entities.fulfillmentOrderIds.length > 0) {
      const firstOrder = fulfillmentService.getFulfillment(
        workflow.entities.fulfillmentOrderIds[0]
      );
      if (firstOrder && firstOrder.status === 'VERIFIED') {
        return {
          canResume: true,
          canRecover: true,
          recommendedAction: 'ADVANCE_STAGE',
          resumeStage: 'ALLOCATE',
          targetStatus: 'ALLOCATING_RESIDENT_DEMAND',
          classification: 'RETRYABLE',
          reason: 'FULFILLMENT_ALREADY_VERIFIED: Resuming from resident allocation',
        };
      }
    }

    // Inspect authoritative allocation state
    if (workflow.entities.commitmentId) {
      const summary = allocationService.getCommitmentAllocationSummary(
        workflow.entities.commitmentId
      );
      if (summary && summary.status === 'FINALIZED') {
        return {
          canResume: true,
          canRecover: true,
          recommendedAction: 'ADVANCE_STAGE',
          resumeStage: 'RECONCILE',
          targetStatus: 'RECONCILING',
          classification: 'RETRYABLE',
          reason: 'ALLOCATION_ALREADY_FINALIZED: Resuming from reconciliation',
        };
      }
    }

    // Evaluate failed workflow
    if (workflow.status === 'FAILED') {
      const isRetryable =
        workflow.failureClassification === 'RETRYABLE' ||
        (workflow.failureReason &&
          (workflow.failureReason.includes('TIMEOUT') ||
            workflow.failureReason.includes('NETWORK') ||
            workflow.failureReason.includes('ETIMEDOUT') ||
            workflow.failureReason.includes('GATEWAY')));

      if (!isRetryable) {
        return {
          canResume: false,
          canRecover: false,
          recommendedAction: 'NONE',
          resumeStage: workflow.currentStage,
          targetStatus: 'FAILED',
          classification: workflow.failureClassification || 'NON_RETRYABLE',
          reason: `NON_RETRYABLE_FAILURE: ${workflow.failureReason || 'Terminal failure'}`,
        };
      }

      return {
        canResume: true,
        canRecover: true,
        recommendedAction: 'RETRY_STAGE',
        resumeStage: latestCheckpoint?.stage || workflow.currentStage,
        targetStatus: latestCheckpoint?.status || 'UNDERSTANDING',
        classification: 'RETRYABLE',
        reason: 'RETRYABLE_TRANSIENT_FAILURE: Resuming from last valid checkpoint',
      };
    }

    if (!latestCheckpoint) {
      return {
        canResume: true,
        canRecover: true,
        recommendedAction: 'RESUME_CHECKPOINT',
        resumeStage: workflow.currentStage,
        targetStatus: workflow.status,
        classification: 'RETRYABLE',
        reason: 'Resuming active workflow from current stage',
      };
    }

    // Standard resumption from checkpoint
    return {
      canResume: true,
      canRecover: true,
      recommendedAction: 'RESUME_CHECKPOINT',
      resumeStage: latestCheckpoint.stage,
      targetStatus: latestCheckpoint.status,
      classification: 'RETRYABLE',
      reason: 'CHECKPOINT_RESUMPTION: Workflow state restored successfully',
    };
  }

  /**
   * Resumes workflow by applying recovery evaluation.
   */
  public resumeWorkflow(workflow: RelayWorkflow): RelayWorkflow {
    const evalResult = this.evaluateRecovery(workflow);
    if (!evalResult.canResume) {
      throw new Error(`Cannot resume workflow '${workflow.id}': ${evalResult.reason}`);
    }

    moveWorkflowStageForRecovery(workflow, evalResult.resumeStage);
    transitionWorkflowStatus(workflow, evalResult.targetStatus);
    resetWorkflowStagesAfter(workflow.stages, evalResult.resumeStage);
    workflow.failureReason = undefined;
    workflow.failureClassification = undefined;
    workflow.isPaused = false;
    workflow.pauseReason = undefined;
    workflow.retryCount += 1;
    workflow.workflowVersion += 1;
    workflow.updatedAt = new Date();

    this.eventService.emit('WORKFLOW_RETRYING', workflow.id, workflow.currentStage, {
      resumeStage: evalResult.resumeStage,
      targetStatus: evalResult.targetStatus,
      retryCount: workflow.retryCount,
      reason: evalResult.reason,
    });

    return workflow;
  }
}

export const workflowRecoveryService = new WorkflowRecoveryService();
