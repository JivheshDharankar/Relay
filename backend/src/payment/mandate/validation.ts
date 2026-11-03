import { z } from 'zod';
import {
  addDecimals,
  isLessThan,
  roundMoney,
  subtractDecimals,
  toDecimal,
} from '../../domain/procurement/decimal';
import { MandateValidationResult, PaymentMandate, PaymentPurpose } from './types';

export class MandateValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Mandate validation failed: ${errors.join('; ')}`);
    this.name = 'MandateValidationError';
  }
}

/**
 * Authoritative ceiling for any resident spending limit, matching the
 * onboarding authorization boundary. Single source for payment-limit
 * validation in the payment domain.
 */
export const MANDATE_SPENDING_LIMIT_CEILING = 1000000;

/**
 * Deterministic request validation for resident-initiated limit changes.
 * Rejects malformed, non-finite, non-positive, and over-ceiling values.
 * The service layer re-validates numerically as the final backstop.
 */
export const UpdateMandateLimitSchema = z.object({
  spendingLimit: z
    .number()
    .finite('Spending limit must be a finite number')
    .positive('Spending limit must be greater than 0')
    .max(
      MANDATE_SPENDING_LIMIT_CEILING,
      `Spending limit exceeds maximum allowable ceiling of ₹${MANDATE_SPENDING_LIMIT_CEILING.toLocaleString('en-IN')}`
    ),
});

/**
 * Deterministically evaluates whether a mandate permits an authorized payment request
 * according to status, time window, purpose, currency, and remaining spending capacity.
 */
export function validateMandateForPayment(
  mandate: PaymentMandate | undefined,
  request: {
    amount: number;
    currency: string;
    purpose: PaymentPurpose;
  },
  options?: {
    referenceTime?: Date;
  }
): MandateValidationResult {
  const errors: string[] = [];
  const referenceTime = options?.referenceTime ?? new Date();

  // 1. Mandate Existence
  if (!mandate) {
    errors.push('MANDATE_NOT_FOUND: Mandate does not exist');
    return { valid: false, errors, remainingCapacity: 0 };
  }

  // 2. Mandate Status
  if (mandate.status === 'PAUSED') {
    errors.push('MANDATE_PAUSED: Payment mandate is currently paused by administrator');
  } else if (mandate.status === 'REVOKED') {
    errors.push('MANDATE_REVOKED: Payment mandate has been permanently revoked');
  } else if (mandate.status === 'EXPIRED') {
    errors.push('MANDATE_EXPIRED: Payment mandate status is expired');
  } else if (mandate.status !== 'ACTIVE') {
    errors.push(`MANDATE_INACTIVE: Mandate is in inactive status '${mandate.status}'`);
  }

  // 3. Time Validity Window
  if (mandate.validFrom && referenceTime.getTime() < mandate.validFrom.getTime()) {
    errors.push(
      `MANDATE_NOT_YET_VALID: Mandate becomes valid at ${mandate.validFrom.toISOString()}`
    );
  }
  if (mandate.validUntil && referenceTime.getTime() > mandate.validUntil.getTime()) {
    errors.push(
      `MANDATE_EXPIRED: Mandate expired at ${mandate.validUntil.toISOString()}`
    );
  }

  // 4. Purpose Match
  if (mandate.purpose !== request.purpose) {
    errors.push(
      `PURPOSE_MISMATCH: Mandate purpose '${mandate.purpose}' does not authorize payment purpose '${request.purpose}'`
    );
  }

  // 5. Currency Match
  if (mandate.currency.toUpperCase() !== request.currency.toUpperCase()) {
    errors.push(
      `CURRENCY_MISMATCH: Mandate currency '${mandate.currency}' does not match requested currency '${request.currency}'`
    );
  }

  // 6. Spending Limit & Capacity (Strict Decimal Arithmetic)
  const spentDecimal = toDecimal(mandate.spentAmount);
  const reservedDecimal = toDecimal(mandate.reservedAmount);
  const limitDecimal = toDecimal(mandate.spendingLimit);
  const requestAmountDecimal = toDecimal(request.amount);

  const totalCommittedOrReserved = addDecimals(spentDecimal, reservedDecimal);
  const remainingCapacityDecimal = subtractDecimals(limitDecimal, totalCommittedOrReserved);
  const remainingCapacity = Math.max(0, roundMoney(remainingCapacityDecimal).toNumber());

  if (isLessThan(remainingCapacityDecimal, requestAmountDecimal)) {
    errors.push(
      `SPENDING_LIMIT_EXCEEDED: Requested payment ₹${request.amount} exceeds available mandate capacity ₹${remainingCapacity} (Limit: ₹${mandate.spendingLimit}, Spent: ₹${mandate.spentAmount}, Reserved: ₹${mandate.reservedAmount})`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    remainingCapacity,
  };
}

