import { randomUUID } from 'crypto';
import { RelayWorkflow, WorkflowCheckpoint, WorkflowStage } from './types';
import { workflowPersistenceService } from './WorkflowPersistenceService';

export class WorkflowCheckpointService {
  private checkpoints = new Map<string, WorkflowCheckpoint>();
  private checkpointsByWorkflow = new Map<string, WorkflowCheckpoint[]>();

  /**
   * Persists an operational checkpoint capturing authoritative entity references and status.
   */
  public saveCheckpoint(
    workflow: RelayWorkflow,
    snapshot?: Record<string, unknown>
  ): WorkflowCheckpoint {
    const existingList = this.checkpointsByWorkflow.get(workflow.id) || [];

    const existing = existingList.find(
      (c) => c.stage === workflow.currentStage && c.workflowVersion === workflow.workflowVersion
    );
    if (existing) {
      return existing; // Idempotent return
    }

    const checkpoint: WorkflowCheckpoint = {
      id: `chk_${randomUUID().slice(0, 10)}`,
      workflowId: workflow.id,
      stage: workflow.currentStage,
      status: workflow.status,
      entities: { ...workflow.entities },
      snapshot: { ...workflow },
      stateSnapshot: snapshot ? { ...snapshot } : undefined,
      workflowVersion: workflow.workflowVersion,
      timestamp: new Date(),
    };

    this.checkpoints.set(checkpoint.id, checkpoint);
    existingList.push(checkpoint);
    this.checkpointsByWorkflow.set(workflow.id, existingList);

    // Durable checkpoint row carrying the full snapshot for restart
    // recovery (fire-and-forget: record writes never throw).
    void workflowPersistenceService.recordCheckpoint(checkpoint);

    return checkpoint;
  }

  /**
   * Retrieves the most recent checkpoint for a workflow.
   */
  public getLatestCheckpoint(workflowId: string): WorkflowCheckpoint | undefined {
    const list = this.checkpointsByWorkflow.get(workflowId) || [];
    if (list.length === 0) return undefined;
    return list[list.length - 1];
  }

  /**
   * Retrieves all checkpoints recorded for a workflow.
   */
  public getCheckpoints(workflowId: string): WorkflowCheckpoint[] {
    return this.checkpointsByWorkflow.get(workflowId) || [];
  }

  /**
   * Convenience alias: lists checkpoints recorded for a workflow.
   */
  public listCheckpoints(workflowId: string): WorkflowCheckpoint[] {
    return this.getCheckpoints(workflowId);
  }

  /**
   * Retrieves a checkpoint for a specific stage.
   */
  public getCheckpointForStage(
    workflowId: string,
    stage: WorkflowStage
  ): WorkflowCheckpoint | undefined {
    const list = this.checkpointsByWorkflow.get(workflowId) || [];
    return list.find((c) => c.stage === stage);
  }

  /**
   * Convenience alias: retrieves a checkpoint for a specific stage.
   */
  public getCheckpointByStage(
    workflowId: string,
    stage: WorkflowStage
  ): WorkflowCheckpoint | undefined {
    return this.getCheckpointForStage(workflowId, stage);
  }
}

export const workflowCheckpointService = new WorkflowCheckpointService();
