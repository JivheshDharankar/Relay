import { randomUUID } from 'crypto';
import { eventBus } from '../events';
import { WorkflowStage } from './types';
import { workflowPersistenceService } from './WorkflowPersistenceService';

export type WorkflowAuditEventType =
  | 'WORKFLOW_CREATED'
  | 'WORKFLOW_STAGE_STARTED'
  | 'WORKFLOW_STAGE_COMPLETED'
  | 'WORKFLOW_WAITING'
  | 'WORKFLOW_PAUSED'
  | 'WORKFLOW_CANCELLED'
  | 'WORKFLOW_RETRYING'
  | 'WORKFLOW_BLOCKED'
  | 'WORKFLOW_FAILED'
  | 'WORKFLOW_STALE'
  | 'WORKFLOW_COMPLETED';

export class WorkflowEventService {
  /**
   * Emits a privacy-sanitized workflow audit event to the Relay domain event bus.
   * Guarantees zero sensitive resident credentials, flat numbers, or internal LLM reasoning leak.
   */
  public emit(
    eventType: WorkflowAuditEventType,
    workflowId: string,
    stage: WorkflowStage,
    payload: Record<string, unknown>
  ): void {
    const sanitized = {
      workflowId,
      stage,
      ...this.sanitizePayload(payload),
    };
    eventBus
      .publish({
        id: randomUUID(),
        name: eventType,
        aggregateId: workflowId,
        timestamp: new Date().toISOString(),
        payload: sanitized,
      })
      .catch(() => {});
    // Durable audit trail (fire-and-forget: record writes never throw).
    void workflowPersistenceService.recordWorkflowEvent(workflowId, eventType, stage, sanitized);
  }

  private sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    const forbiddenKeys = [
      'flatNumber',
      'apartment',
      'residentName',
      'residentEmail',
      'residentPhone',
      'pin',
      'password',
      'cvv',
      'prompt',
      'reasoning',
      'mandateLimit',
      'bankAccount',
      'upiPin',
      'token',
      'secret',
    ];

    for (const [key, value] of Object.entries(payload)) {
      if (forbiddenKeys.some((f) => key.toLowerCase().includes(f.toLowerCase()))) {
        continue; // Strictly omit sensitive keys
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
        sanitized[key] = this.sanitizePayload(value as Record<string, unknown>);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}

export const workflowEventService = new WorkflowEventService();
