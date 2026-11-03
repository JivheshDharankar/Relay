import { FulfillmentStatus, FulfillmentType } from './types';

export class FulfillmentStateMachineError extends Error {
  constructor(
    public readonly currentStatus: FulfillmentStatus,
    public readonly attemptedStatus: FulfillmentStatus,
    public readonly fulfillmentType: FulfillmentType,
    message?: string
  ) {
    super(
      message ||
        `Illegal fulfillment status transition from '${currentStatus}' to '${attemptedStatus}' for ${fulfillmentType}`
    );
    this.name = 'FulfillmentStateMachineError';
  }
}

const PHYSICAL_LEGAL_TRANSITIONS: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  CREATED: ['AWAITING_SUPPLIER_ACCEPTANCE', 'CANCELLED'],
  AWAITING_SUPPLIER_ACCEPTANCE: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['PROCESSING', 'CANCELLED', 'FAILED'],
  PROCESSING: ['DISPATCHED', 'CANCELLED', 'FAILED'],
  DISPATCHED: ['IN_TRANSIT', 'DELIVERED', 'FAILED'],
  IN_TRANSIT: ['DELIVERED', 'FAILED'],
  DELIVERED: ['VERIFIED', 'FAILED'],
  VERIFIED: [], // Terminal
  REJECTED: [], // Terminal
  FAILED: [],   // Terminal
  CANCELLED: [],// Terminal
  SERVICE_SCHEDULED: [],
  SERVICE_IN_PROGRESS: [],
  SERVICE_COMPLETED: [],
};

const SERVICE_LEGAL_TRANSITIONS: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  CREATED: ['AWAITING_SUPPLIER_ACCEPTANCE', 'CANCELLED'],
  AWAITING_SUPPLIER_ACCEPTANCE: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['PROCESSING', 'SERVICE_SCHEDULED', 'CANCELLED', 'FAILED'],
  PROCESSING: ['SERVICE_SCHEDULED', 'SERVICE_IN_PROGRESS', 'CANCELLED', 'FAILED'],
  SERVICE_SCHEDULED: ['SERVICE_IN_PROGRESS', 'CANCELLED', 'FAILED'],
  SERVICE_IN_PROGRESS: ['SERVICE_COMPLETED', 'FAILED'],
  SERVICE_COMPLETED: ['VERIFIED', 'FAILED'],
  VERIFIED: [], // Terminal
  REJECTED: [], // Terminal
  FAILED: [],   // Terminal
  CANCELLED: [],// Terminal
  DISPATCHED: [],
  IN_TRANSIT: [],
  DELIVERED: [],
};

/**
 * Checks whether a proposed status transition is legal for the given fulfillment type.
 */
export function canTransitionFulfillment(
  current: FulfillmentStatus,
  next: FulfillmentStatus,
  fulfillmentType: FulfillmentType = 'PHYSICAL_GOODS'
): boolean {
  if (current === next) return true;
  const legalMap =
    fulfillmentType === 'SERVICE'
      ? SERVICE_LEGAL_TRANSITIONS
      : PHYSICAL_LEGAL_TRANSITIONS;

  const legalNext = legalMap[current] || [];
  return legalNext.includes(next);
}

/**
 * Asserts that a proposed transition is valid; throws FulfillmentStateMachineError if illegal.
 */
export function assertLegalFulfillmentTransition(
  current: FulfillmentStatus,
  next: FulfillmentStatus,
  fulfillmentType: FulfillmentType = 'PHYSICAL_GOODS'
): void {
  if (!canTransitionFulfillment(current, next, fulfillmentType)) {
    throw new FulfillmentStateMachineError(current, next, fulfillmentType);
  }
}
