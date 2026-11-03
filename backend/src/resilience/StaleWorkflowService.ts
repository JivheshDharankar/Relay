import { RelayWorkflow, WorkflowStage } from '../orchestration/types';
import { WorkflowEventService, workflowEventService } from '../orchestration/WorkflowEventService';
import { RecoveryAction, StaleWorkflowEvaluation } from './types';

export interface StaleWorkflowThresholds {
  defaultThresholdSeconds: number;
  stageThresholds: Partial<Record<WorkflowStage, number>>;
}

export const DEFAULT_STALE_THRESHOLDS: StaleWorkflowThresholds = {
  defaultThresholdSeconds: 300, // 5 minutes
  stageThresholds: {
    UNDERSTAND: 60, // 1 minute
    DISCOVER: 120, // 2 minutes
    QUALIFY: 120,
    QUOTE: 180, // 3 minutes
    NEGOTIATE: 180,
    SELECT: 60,
    COMMIT: 60,
    PAY: 120, // 2 minutes before triggering authoritative inspection
    FULFILL: 3600, // 1 hour
    VERIFY: 300,
    ALLOCATE: 120,
    RECONCILE: 120,
    COMPLETE: 60,
  },
};

export class StaleWorkflowService {
  constructor(private readonly thresholds: StaleWorkflowThresholds = DEFAULT_STALE_THRESHOLDS) {}

  /**
   * Evaluates if a workflow has stalled or stopped making forward progress.
   */
  public evaluateWorkflow(workflow: RelayWorkflow, now: Date = new Date()): StaleWorkflowEvaluation {
    if (workflow.status === 'COMPLETED') {
      return {
        workflowId: workflow.id,
        isStale: false,
        ageSeconds: Math.floor((now.getTime() - workflow.createdAt.getTime()) / 1000),
        idleSeconds: Math.floor((now.getTime() - workflow.updatedAt.getTime()) / 1000),
        stage: workflow.currentStage,
        status: workflow.status,
        thresholdSeconds: 0,
        recommendedAction: 'NONE',
        reason: 'Workflow is in terminal COMPLETED state; not stale',
      };
    }

    if (workflow.status === 'CANCELLED') {
      return {
        workflowId: workflow.id,
        isStale: false,
        ageSeconds: Math.floor((now.getTime() - workflow.createdAt.getTime()) / 1000),
        idleSeconds: Math.floor((now.getTime() - workflow.updatedAt.getTime()) / 1000),
        stage: workflow.currentStage,
        status: workflow.status,
        thresholdSeconds: 0,
        recommendedAction: 'NONE',
        reason: 'Workflow is cancelled; not stale',
      };
    }

    const threshold =
      this.thresholds.stageThresholds[workflow.currentStage] ??
      this.thresholds.defaultThresholdSeconds;

    const idleSeconds = Math.max(0, Math.floor((now.getTime() - workflow.updatedAt.getTime()) / 1000));
    const ageSeconds = Math.max(0, Math.floor((now.getTime() - workflow.createdAt.getTime()) / 1000));
    const isStale = idleSeconds > threshold;

    let recommendedAction: RecoveryAction = 'NONE';
    let reason = 'Workflow is progressing within expected stage threshold';

    if (isStale) {
      if (workflow.currentStage === 'PAY') {
        recommendedAction = 'ENTER_SAFE_STATE';
        reason = `STALE_PAYMENT_STAGE: Workflow has been idle for ${idleSeconds}s in PAY stage (threshold: ${threshold}s). Check authoritative payment status.`;
      } else if (workflow.currentStage === 'FULFILL') {
        recommendedAction = 'ENTER_SAFE_STATE';
        reason = `STALE_FULFILLMENT_STAGE: Fulfillment tracking idle for ${idleSeconds}s (threshold: ${threshold}s). Inspect supplier delivery progress.`;
      } else if (workflow.status === 'FAILED') {
        recommendedAction = 'RETRY_STAGE';
        reason = `STALE_FAILED_WORKFLOW: Workflow failed ${idleSeconds}s ago without recovery. Evaluate checkpoint resumption.`;
      } else {
        recommendedAction = 'RESUME_CHECKPOINT';
        reason = `STALE_PROGRESSION: Stage '${workflow.currentStage}' idle for ${idleSeconds}s exceeds threshold of ${threshold}s. Resume checkpoint.`;
      }
    }

    return {
      workflowId: workflow.id,
      isStale,
      ageSeconds,
      idleSeconds,
      stage: workflow.currentStage,
      status: workflow.status,
      thresholdSeconds: threshold,
      recommendedAction,
      reason,
    };
  }

  /**
   * Scans a collection of workflows and returns evaluations for all that are stale.
   */
  public findStaleWorkflows(workflows: RelayWorkflow[], now: Date = new Date()): StaleWorkflowEvaluation[] {
    return workflows
      .map((w) => this.evaluateWorkflow(w, now))
      .filter((e) => e.isStale);
  }
}

export const staleWorkflowService = new StaleWorkflowService();

export interface WorkflowLister {
  listWorkflows(): RelayWorkflow[];
}

/**
 * Periodic stale-mission detector. Each sweep evaluates every managed
 * workflow and emits one WORKFLOW_STALE audit event per newly-stale mission
 * (deduplicated until the mission progresses again).
 *
 * Detection only: the sweeper never mutates missions. In particular a stale
 * PAY mission is flagged for OPERATOR inspection of authoritative payment
 * state — automatic retries or cancellations on money-adjacent stages are
 * forbidden.
 */
export class StaleWorkflowSweeper {
  private timer?: ReturnType<typeof setInterval>;
  private emitted = new Set<string>();

  constructor(
    private readonly lister: WorkflowLister,
    private readonly eventSvc: WorkflowEventService = workflowEventService,
    private readonly staleSvc: StaleWorkflowService = staleWorkflowService,
    private readonly intervalMs: number = 60000
  ) {}

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep();
    }, this.intervalMs);
    if (typeof this.timer === 'object' && typeof (this.timer as any).unref === 'function') {
      (this.timer as any).unref();
    }
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public sweep(now: Date = new Date()): StaleWorkflowEvaluation[] {
    const stale = this.staleSvc.findStaleWorkflows(this.lister.listWorkflows(), now);
    const stillStale = new Set(stale.map((e) => e.workflowId));
    for (const id of Array.from(this.emitted)) {
      if (!stillStale.has(id)) {
        this.emitted.delete(id);
      }
    }
    for (const evaluation of stale) {
      if (this.emitted.has(evaluation.workflowId)) {
        continue;
      }
      this.emitted.add(evaluation.workflowId);
      this.eventSvc.emit('WORKFLOW_STALE', evaluation.workflowId, evaluation.stage, {
        idleSeconds: evaluation.idleSeconds,
        thresholdSeconds: evaluation.thresholdSeconds,
        recommendedAction: evaluation.recommendedAction,
        reason: evaluation.reason,
        status: evaluation.status,
      });
      // eslint-disable-next-line no-console
      console.warn(
        `[StaleWorkflow] Mission ${evaluation.workflowId} stale: ${evaluation.reason}`
      );
    }
    return stale;
  }
}
