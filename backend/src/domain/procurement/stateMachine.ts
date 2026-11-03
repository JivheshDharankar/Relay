import { ResidentOrderStatus, CommunityOrderStatus } from '@prisma/client';
import { ProcurementError, ProcurementErrorCode } from './errors';

// ---------------------------------------------------------------------------
// RESIDENT ORDER STATE MACHINE
// ---------------------------------------------------------------------------

const VALID_RESIDENT_ORDER_TRANSITIONS: Record<
  ResidentOrderStatus,
  ResidentOrderStatus[]
> = {
  [ResidentOrderStatus.PENDING]: [
    ResidentOrderStatus.AGGREGATING,
    ResidentOrderStatus.PROCURED,
    ResidentOrderStatus.CANCELLED,
    ResidentOrderStatus.FAILED,
  ],
  [ResidentOrderStatus.AGGREGATING]: [
    ResidentOrderStatus.PROCURED,
    ResidentOrderStatus.PENDING, // Rollback if aggregation window expires without matching pool
    ResidentOrderStatus.CANCELLED,
    ResidentOrderStatus.FAILED,
  ],
  [ResidentOrderStatus.PROCURED]: [
    ResidentOrderStatus.PAYMENT_PENDING,
    ResidentOrderStatus.CANCELLED,
    ResidentOrderStatus.FAILED,
  ],
  [ResidentOrderStatus.PAYMENT_PENDING]: [
    ResidentOrderStatus.PAID,
    ResidentOrderStatus.FAILED,
    ResidentOrderStatus.CANCELLED,
  ],
  [ResidentOrderStatus.PAID]: [
    ResidentOrderStatus.FULFILLING,
    ResidentOrderStatus.CANCELLED, // Requires refund process
  ],
  [ResidentOrderStatus.FULFILLING]: [
    ResidentOrderStatus.DELIVERED,
    ResidentOrderStatus.FAILED,
  ],
  [ResidentOrderStatus.DELIVERED]: [], // Terminal success
  [ResidentOrderStatus.CANCELLED]: [], // Terminal cancellation
  [ResidentOrderStatus.FAILED]: [ResidentOrderStatus.PENDING], // Explicit retry from failed
};

/**
 * Validates a requested transition for a ResidentOrder.
 * Throws ProcurementError(INVALID_STATE_TRANSITION) if illegal.
 */
export function validateResidentOrderTransition(
  current: ResidentOrderStatus,
  next: ResidentOrderStatus
): void {
  if (current === next) return;

  const allowed = VALID_RESIDENT_ORDER_TRANSITIONS[current] || [];
  if (!allowed.includes(next)) {
    throw new ProcurementError(
      ProcurementErrorCode.INVALID_STATE_TRANSITION,
      `Invalid ResidentOrder transition from ${current} to ${next}`
    );
  }
}

// ---------------------------------------------------------------------------
// COMMUNITY ORDER STATE MACHINE
// ---------------------------------------------------------------------------

const VALID_COMMUNITY_ORDER_TRANSITIONS: Record<
  CommunityOrderStatus,
  CommunityOrderStatus[]
> = {
  [CommunityOrderStatus.CREATED]: [
    CommunityOrderStatus.PAYMENT_AUTHORIZED,
    CommunityOrderStatus.CANCELLED,
    CommunityOrderStatus.FAILED,
  ],
  [CommunityOrderStatus.PAYMENT_AUTHORIZED]: [
    CommunityOrderStatus.PAYMENT_SUCCESS,
    CommunityOrderStatus.FAILED,
    CommunityOrderStatus.CANCELLED,
  ],
  [CommunityOrderStatus.PAYMENT_SUCCESS]: [
    CommunityOrderStatus.SUPPLIER_CONFIRMED,
    CommunityOrderStatus.FAILED,
    CommunityOrderStatus.CANCELLED,
  ],
  [CommunityOrderStatus.SUPPLIER_CONFIRMED]: [
    CommunityOrderStatus.DISPATCHED,
    CommunityOrderStatus.CANCELLED,
    CommunityOrderStatus.FAILED,
  ],
  [CommunityOrderStatus.DISPATCHED]: [
    CommunityOrderStatus.DELIVERED,
    CommunityOrderStatus.FAILED,
  ],
  [CommunityOrderStatus.DELIVERED]: [
    CommunityOrderStatus.RECONCILED,
    CommunityOrderStatus.FAILED,
  ],
  [CommunityOrderStatus.RECONCILED]: [], // Terminal success
  [CommunityOrderStatus.CANCELLED]: [], // Terminal cancellation
  [CommunityOrderStatus.FAILED]: [], // Terminal failure
};

/**
 * Validates a requested transition for a CommunityOrder.
 * Throws ProcurementError(INVALID_STATE_TRANSITION) if illegal.
 */
export function validateCommunityOrderTransition(
  current: CommunityOrderStatus,
  next: CommunityOrderStatus
): void {
  if (current === next) return;

  const allowed = VALID_COMMUNITY_ORDER_TRANSITIONS[current] || [];
  if (!allowed.includes(next)) {
    throw new ProcurementError(
      ProcurementErrorCode.INVALID_STATE_TRANSITION,
      `Invalid CommunityOrder transition from ${current} to ${next}`
    );
  }
}
