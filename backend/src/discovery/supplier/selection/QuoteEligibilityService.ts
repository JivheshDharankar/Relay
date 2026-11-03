import { Quote } from '../quote/types';
import { RFQ } from '../rfq/types';
import { QuoteEligibilityResult } from './types';

export class QuoteEligibilityService {
  /**
   * Deterministically evaluates whether a normalized quote meets all hard qualification,
   * RFQ consistency, SLA deadline, and quantity constraints.
   */
  public evaluateQuoteEligibility(
    quote: Quote,
    rfq: RFQ,
    options?: {
      moqMap?: Map<string, number>;
      referenceTime?: Date;
      allowCrossSupplier?: boolean;
    }
  ): QuoteEligibilityResult {
    const reasons: string[] = [];
    const referenceTime = options?.referenceTime ?? new Date();

    // 1. RFQ State Consistency
    if (rfq.status === 'CANCELLED' || rfq.status === 'EXPIRED' || rfq.status === 'FAILED') {
      reasons.push(`RFQ_INACTIVE: Originating RFQ '${rfq.id}' is in '${rfq.status}' status`);
    }

    if (!options?.allowCrossSupplier) {
      // 2. RFQ Relationship Match
      if (quote.rfqId !== rfq.id) {
        reasons.push(`WRONG_RFQ: Quote RFQ reference '${quote.rfqId}' does not match '${rfq.id}'`);
      }

      // 3. Supplier Candidate Consistency
      if (quote.candidateId !== rfq.candidateId) {
        reasons.push(
          `SUPPLIER_MISMATCH: Quote candidate '${quote.candidateId}' does not match RFQ candidate '${rfq.candidateId}'`
        );
      }
    }

    // 4. Quote State Validation
    if (quote.status === 'INVALID') {
      reasons.push(
        `QUOTE_INVALID: Quote is marked INVALID (${quote.rejectionReasons?.join(', ') || 'failed checks'})`
      );
    }

    // 5. Quote Expiration Check
    if (quote.validUntil.getTime() <= referenceTime.getTime()) {
      reasons.push(
        `QUOTE_EXPIRED: Quote expired at ${quote.validUntil.toISOString()} (current: ${referenceTime.toISOString()})`
      );
    }

    // 6. Financial Integrity Check
    if (quote.hasTotalMismatch) {
      reasons.push(
        `FINANCIAL_DISCREPANCY: Quote has unverified total mismatch difference of ₹${quote.totalMismatchDifference ?? 0}`
      );
    }
    if (quote.total < 0 || quote.subtotal < 0 || quote.deliveryFee < 0) {
      reasons.push('NEGATIVE_CHARGES: Quote contains invalid negative financial charges');
    }

    // 7. Quantity & Availability Check
    const totalOfferedQty = quote.lineItems.reduce((acc, li) => acc + li.quotedQuantity, 0);
    const totalRequestedQty = rfq.lineItems.reduce((acc, li) => acc + li.quantity, 0);

    if (totalOfferedQty <= 0) {
      reasons.push('INSUFFICIENT_QUANTITY: Quoted quantity is zero or negative');
    }

    const isEligibleForSplit = totalOfferedQty > 0 && totalOfferedQty < totalRequestedQty;

    // 8. MOQ (Minimum Order Quantity) Satisfaction Check
    const candidateMoq = options?.moqMap?.get(quote.candidateId) ?? 1;
    let moqSatisfied = true;
    if (totalOfferedQty < candidateMoq) {
      moqSatisfied = false;
      reasons.push(
        `MOQ_VIOLATION: Quoted quantity (${totalOfferedQty}) is below supplier minimum order quantity (${candidateMoq})`
      );
    }

    // 9. Delivery SLA Deadline Check
    const slaDeadline = rfq.deliveryDeadline ?? new Date(referenceTime.getTime() + 86400000);
    let remainingSlaHours = 0;
    let isSlaCompliant = false;

    if (typeof quote.deliveryEtaHours === 'number') {
      const estimatedDelivery = new Date(
        quote.receivedAt.getTime() + quote.deliveryEtaHours * 3600 * 1000
      );
      isSlaCompliant = estimatedDelivery.getTime() <= slaDeadline.getTime();
      remainingSlaHours = (slaDeadline.getTime() - estimatedDelivery.getTime()) / (3600 * 1000);
    } else if (quote.confirmedDeliveryEta) {
      isSlaCompliant = quote.confirmedDeliveryEta.getTime() <= slaDeadline.getTime();
      remainingSlaHours =
        (slaDeadline.getTime() - quote.confirmedDeliveryEta.getTime()) / (3600 * 1000);
    } else {
      reasons.push('DELIVERY_TIME_UNKNOWN: Quote does not specify delivery turnaround');
    }

    if (!isSlaCompliant && (quote.confirmedDeliveryEta || typeof quote.deliveryEtaHours === 'number')) {
      reasons.push(
        `SLA_DEADLINE_EXCEEDED: Promised delivery exceeds RFQ SLA deadline ${slaDeadline.toISOString()}`
      );
    }

    const isEligible = reasons.length === 0;

    return {
      quoteId: quote.id,
      candidateId: quote.candidateId,
      supplierName: quote.supplierName,
      isEligible,
      reasons,
      isEligibleForSplit: isEligible && isEligibleForSplit,
      remainingSlaHours: Math.max(0, Math.round(remainingSlaHours * 10) / 10),
      moqSatisfied,
      quote,
    };
  }

  /**
   * Filters a list of quotes and returns only those that strictly pass all eligibility checks.
   */
  public filterEligibleQuotes(
    quotes: Quote[],
    rfq: RFQ,
    options?: {
      moqMap?: Map<string, number>;
      referenceTime?: Date;
    }
  ): {
    eligible: QuoteEligibilityResult[];
    ineligible: QuoteEligibilityResult[];
  } {
    const results = quotes.map((q) => this.evaluateQuoteEligibility(q, rfq, options));
    return {
      eligible: results.filter((r) => r.isEligible),
      ineligible: results.filter((r) => !r.isEligible),
    };
  }
}

export const quoteEligibilityService = new QuoteEligibilityService();
