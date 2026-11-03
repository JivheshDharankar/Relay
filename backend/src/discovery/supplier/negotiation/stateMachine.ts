import { NegotiationStatus } from './types';

export class NegotiationStateMachineError extends Error {
  constructor(
    public readonly currentStatus: NegotiationStatus,
    public readonly attemptedStatus: NegotiationStatus,
    message?: string
  ) {
    super(
      message ||
        `Illegal negotiation status transition from '${currentStatus}' to '${attemptedStatus}'`
    );
    this.name = 'NegotiationStateMachineError';
  }
}

const LEGAL_TRANSITIONS: Record<NegotiationStatus, NegotiationStatus[]> = {
  READY: ['PROPOSED', 'STOPPED', 'FAILED'],
  PROPOSED: ['SENT', 'STOPPED', 'FAILED'],
  SENT: ['WAITING_FOR_RESPONSE', 'STOPPED', 'FAILED'],
  WAITING_FOR_RESPONSE: ['COUNTERED', 'ACCEPTABLE', 'STOPPED', 'EXPIRED', 'FAILED'],
  COUNTERED: ['REVIEWING', 'STOPPED', 'FAILED'],
  REVIEWING: ['ACCEPTABLE', 'ANOTHER_ROUND', 'STOPPED', 'FAILED'],
  ANOTHER_ROUND: ['PROPOSED', 'STOPPED', 'FAILED'],
  ACCEPTABLE: [], // Terminal
  STOPPED: [],    // Terminal
  EXPIRED: [],    // Terminal
  FAILED: [],     // Terminal
};

/**
 * Checks whether a transition between two negotiation statuses is permitted.
 */
export function canTransitionNegotiation(
  current: NegotiationStatus,
  next: NegotiationStatus
): boolean {
  if (current === next) return true;
  const legalNext = LEGAL_TRANSITIONS[current] || [];
  return legalNext.includes(next);
}

/**
 * Asserts that a negotiation status transition is legal according to the domain state machine.
 * Throws NegotiationStateMachineError if illegal.
 */
export function assertLegalNegotiationTransition(
  current: NegotiationStatus,
  next: NegotiationStatus
): void {
  if (!canTransitionNegotiation(current, next)) {
    throw new NegotiationStateMachineError(current, next);
  }
}

