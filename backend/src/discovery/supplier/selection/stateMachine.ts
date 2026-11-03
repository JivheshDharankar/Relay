import { CommitmentStatus } from './types';

export class CommitmentStateMachineError extends Error {
  constructor(
    public readonly currentStatus: CommitmentStatus,
    public readonly attemptedStatus: CommitmentStatus,
    message?: string
  ) {
    super(
      message ||
        `Illegal procurement commitment status transition from '${currentStatus}' to '${attemptedStatus}'`
    );
    this.name = 'CommitmentStateMachineError';
  }
}

const LEGAL_TRANSITIONS: Record<CommitmentStatus, CommitmentStatus[]> = {
  DRAFT: ['VALIDATED', 'FAILED', 'CANCELLED'],
  VALIDATED: ['COMMITTED', 'FAILED', 'CANCELLED'],
  COMMITTED: ['PURCHASE_ORDER_CREATED', 'CANCELLED', 'FAILED'],
  PURCHASE_ORDER_CREATED: ['READY_FOR_PAYMENT', 'CANCELLED', 'FAILED'],
  READY_FOR_PAYMENT: ['PAID', 'FAILED', 'CANCELLED'], // Advances to PAID upon Phase 7 payment success
  PAID: [],              // Terminal post-payment
  CANCELLED: [],         // Terminal
  EXPIRED: [],           // Terminal
  FAILED: [],            // Terminal
};

/**
 * Checks whether a transition between two commitment statuses is legal.
 */
export function canTransitionCommitment(
  current: CommitmentStatus,
  next: CommitmentStatus
): boolean {
  if (current === next) return true;
  const legalNext = LEGAL_TRANSITIONS[current] || [];
  return legalNext.includes(next);
}

/**
 * Asserts that a commitment transition is valid according to the domain state machine.
 * Throws CommitmentStateMachineError if illegal.
 */
export function assertLegalCommitmentTransition(
  current: CommitmentStatus,
  next: CommitmentStatus
): void {
  if (!canTransitionCommitment(current, next)) {
    throw new CommitmentStateMachineError(current, next);
  }
}

