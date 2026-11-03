import {
  ProcurementCommitment,
  PurchaseOrder,
} from '../discovery/supplier/selection/types';
import { Payment } from '../payment/types';
import { canTransitionFulfillment } from './stateMachine';
import {
  FulfillmentOrder,
  SupplierFulfillmentEvent,
  SupplierFulfillmentEventType,
  FulfillmentStatus,
} from './types';

export class FulfillmentValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Fulfillment validation failed: ${errors.join('; ')}`);
    this.name = 'FulfillmentValidationError';
  }
}

/**
 * Validates that an order being created has a corresponding successful payment and matching PO.
 */
export function validatePaymentLinkage(
  commitment: ProcurementCommitment | undefined,
  purchaseOrder: PurchaseOrder | undefined,
  payment: Payment | undefined
): void {
  const errors: string[] = [];

  if (!commitment) {
    errors.push('COMMITMENT_NOT_FOUND: Procurement commitment record does not exist');
  }

  if (!purchaseOrder) {
    errors.push('PURCHASE_ORDER_NOT_FOUND: Purchase order record does not exist');
  } else if (commitment && purchaseOrder.commitmentId !== commitment.id) {
    errors.push(
      `PO_COMMITMENT_MISMATCH: Purchase order commitment reference '${purchaseOrder.commitmentId}' does not match '${commitment.id}'`
    );
  }

  if (!payment) {
    errors.push('PAYMENT_REQUIRED: No payment record found for this purchase order');
  } else {
    if (payment.status !== 'SUCCEEDED') {
      errors.push(
        `UNPAID_COMMITMENT: Payment status is '${payment.status}'; fulfillment requires SUCCEEDED payment`
      );
    }
    if (purchaseOrder && payment.supplierId !== purchaseOrder.supplierId) {
      errors.push(
        `SUPPLIER_MISMATCH: Payment supplier '${payment.supplierId}' does not match purchase order supplier '${purchaseOrder.supplierId}'`
      );
    }
    if (purchaseOrder && payment.purchaseOrderId !== purchaseOrder.id) {
      errors.push(
        `PO_PAYMENT_MISMATCH: Payment purchaseOrderId '${payment.purchaseOrderId}' does not match '${purchaseOrder.id}'`
      );
    }
  }

  if (errors.length > 0) {
    throw new FulfillmentValidationError(errors);
  }
}

/**
 * Validates deterministic quantity integrity for fulfillment tracking.
 */
export function validateQuantities(
  requestedQuantity: number,
  fulfilledQuantity: number
): { remainingQuantity: number } {
  if (requestedQuantity <= 0) {
    throw new FulfillmentValidationError([
      `INVALID_REQUESTED_QUANTITY: Requested quantity must be greater than zero (${requestedQuantity})`,
    ]);
  }

  if (fulfilledQuantity < 0) {
    throw new FulfillmentValidationError([
      `NEGATIVE_QUANTITY: Fulfilled quantity cannot be negative (${fulfilledQuantity})`,
    ]);
  }

  if (fulfilledQuantity > requestedQuantity) {
    throw new FulfillmentValidationError([
      `OVER_FULFILLMENT: Fulfilled quantity (${fulfilledQuantity}) exceeds requested quantity (${requestedQuantity})`,
    ]);
  }

  const remainingQuantity = Math.round((requestedQuantity - fulfilledQuantity) * 10000) / 10000;
  return { remainingQuantity };
}

/**
 * Maps a supplier operational event to its intended fulfillment order status.
 */
export function mapEventToTargetStatus(
  eventType: SupplierFulfillmentEventType,
  fulfillmentType: FulfillmentOrder['fulfillmentType']
): FulfillmentStatus {
  switch (eventType) {
    case 'SUPPLIER_ACCEPTED':
      return 'ACCEPTED';
    case 'SUPPLIER_REJECTED':
      return 'REJECTED';
    case 'FULFILLMENT_STARTED':
    case 'ORDER_PACKED':
      return 'PROCESSING';
    case 'ORDER_DISPATCHED':
      return 'DISPATCHED';
    case 'ORDER_IN_TRANSIT':
      return 'IN_TRANSIT';
    case 'ORDER_DELIVERED':
      return 'DELIVERED';
    case 'SERVICE_SCHEDULED':
      return 'SERVICE_SCHEDULED';
    case 'SERVICE_STARTED':
      return 'SERVICE_IN_PROGRESS';
    case 'SERVICE_COMPLETED':
      return 'SERVICE_COMPLETED';
    case 'FULFILLMENT_FAILED':
      return 'FAILED';
    case 'FULFILLMENT_UPDATED':
      return fulfillmentType === 'SERVICE' ? 'SERVICE_IN_PROGRESS' : 'PROCESSING';
    case 'DELIVERY_ATTEMPTED':
      return 'IN_TRANSIT';
    default:
      throw new FulfillmentValidationError([`UNKNOWN_EVENT_TYPE: Event '${eventType}' is unhandled`]);
  }
}

/**
 * Validates that an ingested supplier event is legal for the target fulfillment order.
 */
export function validateSupplierEvent(
  order: FulfillmentOrder,
  event: SupplierFulfillmentEvent
): void {
  const errors: string[] = [];

  if (order.supplierId !== event.supplierId) {
    errors.push(
      `SUPPLIER_MISMATCH: Event supplierId '${event.supplierId}' does not match order supplierId '${order.supplierId}'`
    );
  }

  const targetStatus = mapEventToTargetStatus(event.eventType, order.fulfillmentType);

  // If the order is already in the target status, it's an idempotent update
  if (order.status !== targetStatus) {
    const isLegal = canTransitionFulfillment(
      order.status,
      targetStatus,
      order.fulfillmentType
    );

    if (!isLegal) {
      errors.push(
        `INVALID_EVENT_TRANSITION: Cannot process '${event.eventType}' from status '${order.status}' to '${targetStatus}'`
      );
    }
  }

  if (errors.length > 0) {
    throw new FulfillmentValidationError(errors);
  }
}

