import { isDecimalEqual, toDecimal } from '../../domain/procurement/decimal';
import {
  ProcurementCommitment,
  PurchaseOrder,
} from '../../discovery/supplier/selection/types';
import { PaymentMandate, PaymentPurpose } from '../mandate/types';
import { validateMandateForPayment } from '../mandate/validation';

export interface AuthorizePaymentRequestInput {
  commitment: ProcurementCommitment;
  purchaseOrder: PurchaseOrder;
  mandate: PaymentMandate;
  amount: number;
  currency: string;
  purpose: PaymentPurpose;
  supplierId: string;
  alreadyPaid?: boolean;
}

export interface PaymentAuthorizationValidationResult {
  valid: boolean;
  errors: string[];
}

export class PaymentAuthorizationValidator {
  /**
   * Deterministically validates an incoming payment instruction against the Phase 6 commitment,
   * purchase order, payment mandate, exact allocation amounts, and privacy boundaries.
   */
  public validate(input: AuthorizePaymentRequestInput): PaymentAuthorizationValidationResult {
    const errors: string[] = [];

    // 1. Commitment State Validation
    if (!input.commitment) {
      errors.push('COMMITMENT_NOT_FOUND: Procurement commitment record does not exist');
      return { valid: false, errors };
    }

    if (input.commitment.status !== 'READY_FOR_PAYMENT') {
      errors.push(
        `COMMITMENT_NOT_PAYABLE: Commitment status is '${input.commitment.status}'; only READY_FOR_PAYMENT commitments can be authorized`
      );
    }

    // 2. Purchase Order State Validation
    if (!input.purchaseOrder) {
      errors.push('PURCHASE_ORDER_NOT_FOUND: Purchase order record does not exist');
      return { valid: false, errors };
    }

    if (input.purchaseOrder.commitmentId !== input.commitment.id) {
      errors.push(
        `PO_COMMITMENT_MISMATCH: Purchase order commitment reference '${input.purchaseOrder.commitmentId}' does not match '${input.commitment.id}'`
      );
    }

    if (input.purchaseOrder.status !== 'READY_FOR_PAYMENT') {
      errors.push(
        `PO_NOT_PAYABLE: Purchase order status is '${input.purchaseOrder.status}'; expected 'READY_FOR_PAYMENT'`
      );
    }

    // 3. Duplicate / Already Paid Check
    if (input.alreadyPaid) {
      errors.push(
        `DUPLICATE_PAYMENT: Purchase order '${input.purchaseOrder.id}' has already been paid or is actively processing`
      );
    }

    // 4. Supplier Recipient Validation (Strict Anti-Spoofing)
    if (input.supplierId !== input.purchaseOrder.supplierId) {
      errors.push(
        `SUPPLIER_MISMATCH: Requested recipient supplier '${input.supplierId}' does not match purchase order supplier '${input.purchaseOrder.supplierId}'`
      );
    }

    // 5. Authoritative Amount Invariant Validation (Strict Decimal Equality)
    const reqAmountDecimal = toDecimal(input.amount);
    const poTotalDecimal = toDecimal(input.purchaseOrder.total);

    if (!isDecimalEqual(reqAmountDecimal, poTotalDecimal)) {
      errors.push(
        `AMOUNT_MISMATCH: Requested payment amount ₹${input.amount} does not equal authoritative purchase order total ₹${input.purchaseOrder.total}`
      );
    }

    // 6. Currency Invariant Validation
    if (
      input.currency.toUpperCase() !== input.commitment.financials.currency.toUpperCase() ||
      input.currency.toUpperCase() !== input.purchaseOrder.currency.toUpperCase()
    ) {
      errors.push(
        `CURRENCY_MISMATCH: Payment currency '${input.currency}' does not match commitment currency '${input.commitment.financials.currency}'`
      );
    }

    // 7. Payment Mandate Validation
    const mandateResult = validateMandateForPayment(input.mandate, {
      amount: input.amount,
      currency: input.currency,
      purpose: input.purpose,
    });

    if (!mandateResult.valid) {
      errors.push(...mandateResult.errors);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

export const paymentAuthorizationValidator = new PaymentAuthorizationValidator();

