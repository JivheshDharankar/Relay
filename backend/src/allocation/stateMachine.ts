import { AllocationStatus, ReconciliationStatus } from './types';

export class AllocationStateMachineError extends Error {
  constructor(
    public readonly currentStatus: string,
    public readonly targetStatus: string,
    message?: string
  ) {
    super(
      message ||
        `Illegal transition from '${currentStatus}' to '${targetStatus}'. Transition is not permitted.`
    );
    this.name = 'AllocationStateMachineError';
  }
}

const LEGAL_ALLOCATION_TRANSITIONS: Record<AllocationStatus, AllocationStatus[]> = {
  PENDING: ['CALCULATED', 'REJECTED'],
  CALCULATED: ['VALIDATED', 'REJECTED'],
  VALIDATED: ['FINALIZED', 'REJECTED'],
  FINALIZED: [], // Terminal; immutable except through explicit correction/reversal
  REJECTED: ['PENDING'], // Allowed to restart calculation from clean slate
};

const LEGAL_RECONCILIATION_TRANSITIONS: Record<ReconciliationStatus, ReconciliationStatus[]> = {
  PENDING: ['IN_PROGRESS'],
  IN_PROGRESS: ['RECONCILED', 'DISCREPANCY', 'BLOCKED'],
  DISCREPANCY: ['IN_PROGRESS'], // Re-evaluation after corrective action
  BLOCKED: ['IN_PROGRESS'],     // Unblocked after prerequisite satisfied
  RECONCILED: [],              // Terminal; immutable
};

/**
 * Checks whether an allocation status transition is legal.
 */
export function canTransitionAllocation(
  current: AllocationStatus,
  next: AllocationStatus
): boolean {
  if (current === next) return true;
  const legalNext = LEGAL_ALLOCATION_TRANSITIONS[current] || [];
  return legalNext.includes(next);
}

/**
 * Asserts that an allocation status transition is valid; throws AllocationStateMachineError if illegal.
 */
export function assertLegalAllocationTransition(
  current: AllocationStatus,
  next: AllocationStatus
): void {
  if (!canTransitionAllocation(current, next)) {
    throw new AllocationStateMachineError(
      current,
      next,
      `Illegal allocation transition: Cannot move from '${current}' to '${next}'`
    );
  }
}

/**
 * Checks whether a reconciliation status transition is legal.
 */
export function canTransitionReconciliation(
  current: ReconciliationStatus,
  next: ReconciliationStatus
): boolean {
  if (current === next) return true;
  const legalNext = LEGAL_RECONCILIATION_TRANSITIONS[current] || [];
  return legalNext.includes(next);
}

/**
 * Asserts that a reconciliation status transition is valid; throws AllocationStateMachineError if illegal.
 */
export function assertLegalReconciliationTransition(
  current: ReconciliationStatus,
  next: ReconciliationStatus
): void {
  if (!canTransitionReconciliation(current, next)) {
    throw new AllocationStateMachineError(
      current,
      next,
      `Illegal reconciliation transition: Cannot move from '${current}' to '${next}'`
    );
  }
}

