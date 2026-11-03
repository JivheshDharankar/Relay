import {
  isDecimalEqual,
  isGreaterThan,
  isLessThan,
  toDecimal,
  DecimalLike,
} from '../domain/procurement/decimal';
import { FulfillmentOrder } from '../fulfillment/types';

export class AllocationValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Allocation validation failed: ${errors.join('; ')}`);
    this.name = 'AllocationValidationError';
  }
}

/**
 * Validates that all contributing fulfillment orders are fully VERIFIED.
 * Resident allocation must not execute or finalize prior to verified fulfillment.
 */
export function validateFulfillmentEntryCondition(fulfillments: FulfillmentOrder[]): void {
  const errors: string[] = [];

  if (!fulfillments || fulfillments.length === 0) {
    errors.push('NO_FULFILLMENT_ORDERS: At least one fulfillment order is required for allocation');
  } else {
    const unverified = fulfillments.filter((f) => f.status !== 'VERIFIED');
    if (unverified.length > 0) {
      errors.push(
        `UNVERIFIED_FULFILLMENT: Cannot allocate before delivery verification. ${unverified.length} order(s) not in VERIFIED status: [${unverified.map((u) => `${u.id}:${u.status}`).join(', ')}]`
      );
    }
  }

  if (errors.length > 0) {
    throw new AllocationValidationError(errors);
  }
}

/**
 * Validates the fundamental quantity conservation invariant:
 * SUM(resident allocated quantity) == authoritative verified fulfilled quantity.
 */
export function validateQuantityConservation(
  allocatedTotal: DecimalLike,
  verifiedFulfilledTotal: DecimalLike
): void {
  const allocated = toDecimal(allocatedTotal);
  const verified = toDecimal(verifiedFulfilledTotal);

  if (isGreaterThan(allocated, verified)) {
    throw new AllocationValidationError([
      `OVER_ALLOCATION_REJECTED: Allocated quantity (${allocated.toString()}) exceeds verified fulfilled quantity (${verified.toString()})`,
    ]);
  }

  if (isLessThan(allocated, verified)) {
    throw new AllocationValidationError([
      `UNDER_ALLOCATION_MISMATCH: Allocated quantity (${allocated.toString()}) does not match verified fulfilled quantity (${verified.toString()})`,
    ]);
  }
}

/**
 * Validates that all quantities and financial values in an allocation are strictly non-negative.
 */
export function validateNonNegativity(values: {
  requestedQuantity?: DecimalLike;
  allocatedQuantity?: DecimalLike;
  unitPrice?: DecimalLike;
  subtotal?: DecimalLike;
  allocatedTax?: DecimalLike;
  allocatedDeliveryFee?: DecimalLike;
  allocatedOtherCharges?: DecimalLike;
  totalAmount?: DecimalLike;
}): void {
  const errors: string[] = [];

  for (const [key, val] of Object.entries(values)) {
    if (val !== undefined) {
      const dec = toDecimal(val);
      if (dec.lessThan(0)) {
        errors.push(`NEGATIVE_VALUE_REJECTED: Field '${key}' cannot be negative (${dec.toString()})`);
      }
    }
  }

  if (errors.length > 0) {
    throw new AllocationValidationError(errors);
  }
}

/**
 * Validates the monetary conservation invariant:
 * SUM(resident total amounts) == authoritative allocatable procurement amount.
 */
export function validateMonetaryConservation(
  allocatedResidentTotal: DecimalLike,
  allocatableProcurementTotal: DecimalLike
): void {
  const allocated = toDecimal(allocatedResidentTotal);
  const total = toDecimal(allocatableProcurementTotal);

  if (!isDecimalEqual(allocated, total)) {
    throw new AllocationValidationError([
      `MONETARY_CONSERVATION_VIOLATION: Sum of resident amounts (₹${allocated.toString()}) does not equal authoritative procurement cost (₹${total.toString()}). Difference: ₹${total.minus(allocated).toString()}`,
    ]);
  }
}

/**
 * Enforces server-side resident data access authorization.
 * Resident A is strictly forbidden from querying or viewing Resident B's financial records.
 */
export function validateResidentAuthorization(
  callingResidentReference: string,
  targetResidentReference: string
): void {
  if (callingResidentReference !== targetResidentReference) {
    throw new AllocationValidationError([
      `UNAUTHORIZED_RESIDENT_ACCESS: Caller '${callingResidentReference}' is not authorized to access accounting records for resident '${targetResidentReference}'`,
    ]);
  }
}

