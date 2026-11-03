import { RFQStatus } from './types';

export class RFQStateMachineError extends Error {
  public readonly fromStatus: RFQStatus;
  public readonly toStatus: RFQStatus;

  constructor(fromStatus: RFQStatus, toStatus: RFQStatus, message?: string) {
    super(
      message || `Illegal RFQ status transition: cannot transition from '${fromStatus}' to '${toStatus}'`
    );
    this.name = 'RFQStateMachineError';
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

/**
 * Deterministic transition rules for RFQ lifecycle.
 */
const LEGAL_TRANSITIONS: Record<RFQStatus, RFQStatus[]> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['DISPATCHING', 'CANCELLED', 'EXPIRED'],
  DISPATCHING: ['SENT', 'FAILED'],
  FAILED: ['DISPATCHING', 'CANCELLED'],
  SENT: ['EXPIRED'],
  EXPIRED: [],
  CANCELLED: [],
};

/**
 * Validates whether a state transition is legal according to Relay's deterministic lifecycle rules.
 */
export function canTransitionRFQ(from: RFQStatus, to: RFQStatus): boolean {
  if (from === to) return true;
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Asserts that an RFQ transition is legal, throwing RFQStateMachineError if not.
 */
export function assertLegalTransition(from: RFQStatus, to: RFQStatus): void {
  if (!canTransitionRFQ(from, to)) {
    throw new RFQStateMachineError(from, to);
  }
}

