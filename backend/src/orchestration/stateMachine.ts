import { WorkflowStage, WorkflowStatus } from './types';

export class WorkflowStateMachineError extends Error {
  constructor(
    public readonly currentStatus: string,
    public readonly targetStatus: string,
    message?: string
  ) {
    super(
      message ||
        `Illegal workflow transition from '${currentStatus}' to '${targetStatus}'. State jumping and illegal progressions are rejected.`
    );
    this.name = 'WorkflowStateMachineError';
  }
}

// Every mid-chain status is a legitimate recovery/unblock target: resume
// restores the last valid checkpoint, whatever stage it captured.
// DRAFT is included: a checkpoint captured before first advancement restores
// to pre-pipeline state (restart-from-scratch), which re-runs UNDERSTAND first
// and therefore cannot skip payment/fulfillment guards.
const RECOVERY_TARGET_STATUSES: WorkflowStatus[] = [
  'DRAFT',
  'UNDERSTANDING',
  'DEMAND_CREATED',
  'DISCOVERING_SUPPLIERS',
  'QUALIFYING_SUPPLIERS',
  'REQUESTING_QUOTES',
  'WAITING_FOR_QUOTES',
  'NEGOTIATING',
  'SELECTING_SUPPLIER',
  'COMMITTING_PROCUREMENT',
  'AUTHORIZING_PAYMENT',
  'EXECUTING_PAYMENT',
  'FULFILLING',
  'DELIVERING',
  'VERIFYING_FULFILLMENT',
  'ALLOCATING_RESIDENT_DEMAND',
  'RECONCILING',
];

const LEGAL_STATUS_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  DRAFT: ['UNDERSTANDING', 'FAILED', 'CANCELLED'],
  RECEIVED: ['UNDERSTANDING', 'FAILED', 'CANCELLED'],
  UNDERSTANDING: ['AWAITING_CLARIFICATION', 'DEMAND_CREATED', 'FAILED', 'CANCELLED'],
  AWAITING_CLARIFICATION: ['UNDERSTANDING', 'DEMAND_CREATED', 'CANCELLED'],
  DEMAND_CREATED: ['UNDERSTANDING', 'DISCOVERING_SUPPLIERS', 'FAILED', 'CANCELLED'],
  DISCOVERING_SUPPLIERS: ['QUALIFYING_SUPPLIERS', 'FAILED', 'BLOCKED', 'CANCELLED'],
  QUALIFYING_SUPPLIERS: ['REQUESTING_QUOTES', 'FAILED', 'BLOCKED', 'CANCELLED'],
  REQUESTING_QUOTES: ['WAITING_FOR_QUOTES', 'FAILED', 'CANCELLED'],
  WAITING_FOR_QUOTES: ['NEGOTIATING', 'SELECTING_SUPPLIER', 'FAILED', 'BLOCKED', 'CANCELLED'],
  NEGOTIATING: ['SELECTING_SUPPLIER', 'FAILED', 'BLOCKED', 'CANCELLED'],
  SELECTING_SUPPLIER: ['COMMITTING_PROCUREMENT', 'FAILED', 'BLOCKED', 'CANCELLED'],
  COMMITTING_PROCUREMENT: ['AUTHORIZING_PAYMENT', 'FAILED', 'CANCELLED'],
  AUTHORIZING_PAYMENT: ['EXECUTING_PAYMENT', 'FAILED', 'BLOCKED', 'CANCELLED'],
  EXECUTING_PAYMENT: ['FULFILLING', 'FAILED', 'BLOCKED', 'CANCELLED'],
  FULFILLING: ['DELIVERING', 'VERIFYING_FULFILLMENT', 'FAILED', 'CANCELLED'],
  DELIVERING: ['VERIFYING_FULFILLMENT', 'FAILED', 'CANCELLED'],
  VERIFYING_FULFILLMENT: ['ALLOCATING_RESIDENT_DEMAND', 'FAILED', 'BLOCKED', 'CANCELLED'],
  ALLOCATING_RESIDENT_DEMAND: ['RECONCILING', 'FAILED', 'CANCELLED'],
  RECONCILING: ['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'],
  COMPLETED: [], // Terminal; immutable
  FAILED: [...RECOVERY_TARGET_STATUSES, 'CANCELLED'],
  BLOCKED: [...RECOVERY_TARGET_STATUSES, 'CANCELLED'],
  CANCELLED: [], // Terminal
};

const LEGAL_STAGE_TRANSITIONS: Record<WorkflowStage, WorkflowStage[]> = {
  UNDERSTAND: ['DISCOVER', 'COMPLETE'],
  DISCOVER: ['QUALIFY'],
  QUALIFY: ['QUOTE'],
  QUOTE: ['NEGOTIATE', 'SELECT'],
  NEGOTIATE: ['SELECT'],
  SELECT: ['COMMIT'],
  COMMIT: ['PAY'],
  PAY: ['FULFILL'],
  FULFILL: ['VERIFY'],
  VERIFY: ['ALLOCATE'],
  ALLOCATE: ['RECONCILE'],
  RECONCILE: ['COMPLETE'],
  COMPLETE: [], // Terminal
};

/**
 * Checks whether a proposed status transition is legal.
 */
export function canTransitionWorkflowStatus(
  current: WorkflowStatus,
  next: WorkflowStatus
): boolean {
  if (current === next) return true;
  const legalNext = LEGAL_STATUS_TRANSITIONS[current] || [];
  return legalNext.includes(next);
}

/**
 * Asserts that a proposed status transition is valid; throws WorkflowStateMachineError if illegal.
 */
export function assertLegalWorkflowStatusTransition(
  current: WorkflowStatus,
  next: WorkflowStatus
): void {
  if (!canTransitionWorkflowStatus(current, next)) {
    throw new WorkflowStateMachineError(
      current,
      next,
      `Illegal workflow status transition: Cannot advance from '${current}' to '${next}'`
    );
  }
}

/**
 * Checks whether a proposed stage transition is legal.
 */
export function canTransitionWorkflowStage(
  current: WorkflowStage,
  next: WorkflowStage
): boolean {
  if (current === next) return true;
  const legalNext = LEGAL_STAGE_TRANSITIONS[current] || [];
  return legalNext.includes(next);
}

/**
 * Asserts that a proposed stage transition is valid; throws WorkflowStateMachineError if illegal.
 */
export function assertLegalWorkflowStageTransition(
  current: WorkflowStage,
  next: WorkflowStage
): void {
  if (!canTransitionWorkflowStage(current, next)) {
    throw new WorkflowStateMachineError(
      current,
      next,
      `Illegal workflow stage transition: Cannot advance from stage '${current}' to '${next}'`
    );
  }
}

export interface MutableWorkflowState {
  status: WorkflowStatus;
  currentStage: WorkflowStage;
  updatedAt: Date;
}

/**
 * The single choke point for workflow status writes: asserts the transition
 * is legal, then applies it. Direct `workflow.status = ...` assignments
 * outside this helper bypass the state machine and are forbidden.
 */
export function transitionWorkflowStatus(
  workflow: MutableWorkflowState,
  next: WorkflowStatus
): void {
  assertLegalWorkflowStatusTransition(workflow.status, next);
  workflow.status = next;
  workflow.updatedAt = new Date();
}

/**
 * The single choke point for FORWARD workflow stage movement: asserts the
 * stage edge is legal, then applies it.
 */
export function transitionWorkflowStage(
  workflow: MutableWorkflowState,
  next: WorkflowStage
): void {
  assertLegalWorkflowStageTransition(workflow.currentStage, next);
  workflow.currentStage = next;
  workflow.updatedAt = new Date();
}

const STAGE_ORDER: WorkflowStage[] = [
  'UNDERSTAND',
  'DISCOVER',
  'QUALIFY',
  'QUOTE',
  'NEGOTIATE',
  'SELECT',
  'COMMIT',
  'PAY',
  'FULFILL',
  'VERIFY',
  'ALLOCATE',
  'RECONCILE',
  'COMPLETE',
];

/**
 * Recovery stage movement: resume normally rewinds to an earlier-or-equal
 * checkpoint stage, but may advance exactly one legal edge past an
 * already-finalized stage (ADVANCE_STAGE). Forward skips are rejected.
 */
export function rewindWorkflowStage(
  workflow: MutableWorkflowState,
  target: WorkflowStage
): void {
  const currentIndex = STAGE_ORDER.indexOf(workflow.currentStage);
  const targetIndex = STAGE_ORDER.indexOf(target);
  if (targetIndex === -1 || currentIndex === -1 || targetIndex > currentIndex) {
    throw new WorkflowStateMachineError(
      workflow.currentStage,
      target,
      `Illegal workflow stage rewind: recovery cannot advance from stage '${workflow.currentStage}' to '${target}'`
    );
  }
  workflow.currentStage = target;
  workflow.updatedAt = new Date();
}

export function moveWorkflowStageForRecovery(
  workflow: MutableWorkflowState,
  target: WorkflowStage
): void {
  const currentIndex = STAGE_ORDER.indexOf(workflow.currentStage);
  const targetIndex = STAGE_ORDER.indexOf(target);
  if (targetIndex > currentIndex) {
    transitionWorkflowStage(workflow, target);
    return;
  }
  rewindWorkflowStage(workflow, target);
}

export interface WorkflowChecklistItem {
  stage: WorkflowStage;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
  completedAt?: Date;
}

/**
 * Resets checklist items strictly AFTER the resume stage to PENDING: their
 * previous outcome is superseded because the work is being redone. The
 * resume stage itself keeps its recorded outcome (markStageOutcome refreshes
 * it when the stage re-runs).
 */
export function resetWorkflowStagesAfter(
  stages: WorkflowChecklistItem[],
  resumeStage: WorkflowStage
): void {
  const resumeIndex = STAGE_ORDER.indexOf(resumeStage);
  for (const item of stages) {
    if (STAGE_ORDER.indexOf(item.stage) > resumeIndex) {
      item.status = 'PENDING';
      item.completedAt = undefined;
    }
  }
}
