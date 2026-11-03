import { prisma } from '../config/prisma';
import type { Prisma } from '@prisma/client';
import type { RelayWorkflow, WorkflowCheckpoint, WorkflowStage } from './types';
import type { WorkflowAuditEventType } from './WorkflowEventService';

/**
 * Durable mission record + restart recovery for the Relay state machine.
 *
 * Source-of-truth contract:
 * - The in-memory RelayWorkflow object is the LIVE execution state.
 * - These PostgreSQL rows are the DURABLE record and the recovery source:
 *   every submit/step/pause/cancel persists a full snapshot, every audit
 *   event and checkpoint is recorded, and `loadWorkflowSnapshot` rebuilds
 *   the exact workflow object after a backend restart.
 *
 * Write methods NEVER throw: a persistence failure is logged and the
 * pipeline continues, because losing the audit trail must not fail live
 * procurement. Read methods (`loadWorkflowSnapshot`) throw on database
 * errors — an operator-driven restore must fail loudly, never silently
 * resume the wrong state.
 */
export class WorkflowPersistenceService {
  /**
   * Upserts the full workflow snapshot row. Awaited on async orchestration
   * boundaries (submit, every step, resume); fire-and-forget from sync
   * pause/cancel paths. Never throws.
   */
  public async persistWorkflowSnapshot(workflow: RelayWorkflow): Promise<void> {
    try {
      const now = new Date();
      await prisma.relayWorkflow.upsert({
        where: { id: workflow.id },
        create: {
          id: workflow.id,
          residentReference: workflow.residentReference,
          societyReference: workflow.societyReference,
          requestText: workflow.requestText,
          status: workflow.status,
          currentStage: workflow.currentStage,
          workflowVersion: workflow.workflowVersion,
          failureReason: workflow.failureReason ?? null,
          startedAt: workflow.startedAt,
          completedAt: workflow.status === 'COMPLETED' ? workflow.completedAt ?? now : null,
          metadata: toJson(workflow.metadata ?? {}),
        },
        update: {
          status: workflow.status,
          currentStage: workflow.currentStage,
          workflowVersion: workflow.workflowVersion,
          failureReason: workflow.failureReason ?? null,
          completedAt: workflow.status === 'COMPLETED' ? workflow.completedAt ?? now : null,
          metadata: toJson(workflow.metadata ?? {}),
        },
      });
    } catch (err) {
      console.warn(
        `[WorkflowPersistence] snapshot write failed for workflow '${workflow.id}':`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Appends one audit event row. Fire-and-forget from the sync emit path.
   * Never throws.
   */
  public async recordWorkflowEvent(
    workflowId: string,
    eventName: WorkflowAuditEventType,
    stage: WorkflowStage,
    payload?: Record<string, unknown>
  ): Promise<void> {
    try {
      await prisma.relayWorkflowEvent.create({
        data: {
          workflowId,
          eventName,
          stage,
          payload: payload ? toJson(payload) : undefined,
        },
      });
    } catch (err) {
      console.warn(
        `[WorkflowPersistence] event write failed for workflow '${workflowId}' (${eventName}):`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Appends one checkpoint row carrying the full workflow snapshot, which
   * is what `loadWorkflowSnapshot` rehydrates from. Fire-and-forget from
   * the sync checkpoint path. Never throws.
   */
  public async recordCheckpoint(checkpoint: WorkflowCheckpoint): Promise<void> {
    try {
      await prisma.relayWorkflowCheckpoint.create({
        data: {
          workflowId: checkpoint.workflowId,
          stage: checkpoint.stage,
          status: checkpoint.status,
          entityIds: toJson(checkpoint.entities),
          stateSnapshot: toJson(checkpoint.snapshot),
          workflowVersion: checkpoint.workflowVersion,
        },
      });
    } catch (err) {
      console.warn(
        `[WorkflowPersistence] checkpoint write failed for workflow '${checkpoint.workflowId}':`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Rebuilds the exact in-memory workflow object from the latest durable
   * checkpoint snapshot. Returns null when no durable record exists.
   * Throws on database errors: restores must fail loudly.
   */
  public async loadWorkflowSnapshot(workflowId: string): Promise<RelayWorkflow | null> {
    const row = await prisma.relayWorkflow.findUnique({ where: { id: workflowId } });
    if (!row) {
      return null;
    }
    const checkpoint = await prisma.relayWorkflowCheckpoint.findFirst({
      where: { workflowId },
      orderBy: { timestamp: 'desc' },
    });
    if (!checkpoint?.stateSnapshot) {
      return null;
    }
    const revived = reviveWorkflowDates(checkpoint.stateSnapshot as Record<string, unknown>);
    if (
      revived['id'] !== workflowId ||
      typeof revived['residentReference'] !== 'string' ||
      typeof revived['societyReference'] !== 'string' ||
      typeof revived['requestText'] !== 'string' ||
      revived['entities'] === null ||
      typeof revived['entities'] !== 'object' ||
      Array.isArray(revived['entities']) ||
      !Array.isArray(revived['stages'])
    ) {
      throw new Error(`Corrupt durable workflow snapshot for '${workflowId}': identity/shape mismatch`);
    }
    // Belt-and-braces: the workflow row carries the freshest status/stage
    // (persisted on every step), the checkpoint the full object graph.
    revived.status = row.status as RelayWorkflow['status'];
    revived.currentStage = row.currentStage as RelayWorkflow['currentStage'];
    revived.workflowVersion = row.workflowVersion;
    revived.failureReason = row.failureReason ?? undefined;
    // Shape-verified above (id/entities/stages/requestText); the unknown
    // hop documents that the cast is guarded by runtime validation.
    return revived as unknown as RelayWorkflow;
  }
}

/** Normalizes to plain JSON so Prisma Json columns never see class instances. */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
}

/** Revives Date fields lost in the JSON snapshot round-trip. */
function reviveWorkflowDates(raw: Record<string, unknown>): Record<string, unknown> & {
  status: RelayWorkflow['status'];
  currentStage: RelayWorkflow['currentStage'];
  workflowVersion: number;
  failureReason?: string;
} {
  const out = { ...raw } as Record<string, unknown> & {
    status: RelayWorkflow['status'];
    currentStage: RelayWorkflow['currentStage'];
    workflowVersion: number;
    failureReason?: string;
  };
  // A durable snapshot missing its required timestamps is corrupt: refuse
  // to resume rather than fabricate epoch dates into a live workflow.
  for (const key of ['startedAt', 'createdAt', 'updatedAt'] as const) {
    const revived = toDate(out[key]);
    if (!revived) {
      throw new Error(`Corrupt durable workflow snapshot: '${key}' is missing or invalid`);
    }
    out[key] = revived;
  }
  const completedAt = toDate(out['completedAt']);
  if (completedAt) out['completedAt'] = completedAt;
  else delete out['completedAt'];
  if (Array.isArray(out['stages'])) {
    out['stages'] = (out['stages'] as Array<Record<string, unknown>>).map((s) => {
      const stage = { ...s };
      const completedAt = toDate(stage['completedAt']);
      if (completedAt) stage['completedAt'] = completedAt;
      else delete stage['completedAt'];
      return stage;
    });
  }
  return out;
}

export const workflowPersistenceService = new WorkflowPersistenceService();
