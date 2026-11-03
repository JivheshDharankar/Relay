import { RelayWorkflow, WorkflowEntities, WorkflowLocation, WorkflowStage, WorkflowStatus } from './types';
import { transitionWorkflowStage, transitionWorkflowStatus } from './stateMachine';

export class WorkflowContext {
  constructor(private workflow: RelayWorkflow) {}

  public getWorkflow(): RelayWorkflow {
    return { ...this.workflow };
  }

  public getWorkflowId(): string {
    return this.workflow.id;
  }

  public getStatus(): WorkflowStatus {
    return this.workflow.status;
  }

  public getCurrentStage(): WorkflowStage {
    return this.workflow.currentStage;
  }

  public getEntities(): WorkflowEntities {
    return { ...this.workflow.entities };
  }

  public getLocation(): WorkflowLocation {
    return { ...this.workflow.location };
  }

  public updateEntities(partial: Partial<WorkflowEntities>): void {
    this.workflow.entities = {
      ...this.workflow.entities,
      ...partial,
    };
    this.workflow.updatedAt = new Date();
  }

  public updateStatus(status: WorkflowStatus): void {
    transitionWorkflowStatus(this.workflow, status);
  }

  public updateStage(stage: WorkflowStage): void {
    transitionWorkflowStage(this.workflow, stage);
  }

  public setFailure(reason: string, classification: RelayWorkflow['failureClassification']): void {
    transitionWorkflowStatus(this.workflow, 'FAILED');
    this.workflow.failureReason = reason;
    this.workflow.failureClassification = classification;
    this.workflow.updatedAt = new Date();
  }

  public setBlocked(reason: string): void {
    transitionWorkflowStatus(this.workflow, 'BLOCKED');
    this.workflow.failureReason = reason;
    this.workflow.failureClassification = 'SYSTEM_BLOCKED';
    this.workflow.updatedAt = new Date();
  }

  public setPaused(isPaused: boolean, reason?: string): void {
    this.workflow.isPaused = isPaused;
    this.workflow.pauseReason = reason;
    this.workflow.updatedAt = new Date();
  }

  public incrementVersion(): number {
    this.workflow.workflowVersion += 1;
    this.workflow.updatedAt = new Date();
    return this.workflow.workflowVersion;
  }
}
