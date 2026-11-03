import { Quote } from '../quote/types';
import { RFQ } from '../rfq/types';
import { QuoteEligibilityService, quoteEligibilityService } from './QuoteEligibilityService';
import {
  AISelectionRecommendation,
  SelectionValidationResult,
} from './types';

export class SelectionValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Selection validation failed: ${errors.join('; ')}`);
    this.name = 'SelectionValidationError';
  }
}

export class SelectionValidator {
  constructor(
    private readonly eligibilityService: QuoteEligibilityService = quoteEligibilityService
  ) {}

  /**
   * Independently validates an untrusted AI selection recommendation against deterministic
   * domain rules, quantity conservation, MOQ satisfaction, and SLA requirements.
   */
  public validateRecommendation(
    recommendation: AISelectionRecommendation,
    rfq: RFQ,
    quotes: Quote[],
    options?: {
      moqMap?: Map<string, number>;
      referenceTime?: Date;
    }
  ): SelectionValidationResult {
    const errors: string[] = [];
    const requestedQuantity = rfq.lineItems.reduce((acc, li) => acc + li.quantity, 0);
    const quoteMap = new Map(quotes.map((q) => [q.id, q]));

    // 1. Validate Decision Type
    if (!['SELECT_SUPPLIER', 'SPLIT_ORDER', 'REJECT_ALL', 'REQUEST_MORE_NEGOTIATION'].includes(recommendation.decision)) {
      errors.push(`INVALID_DECISION: Unknown decision type '${recommendation.decision}'`);
      return { valid: false, errors };
    }

    // 2. REJECT_ALL Validation
    if (recommendation.decision === 'REJECT_ALL') {
      if (!recommendation.reason || recommendation.reason.trim().length === 0) {
        errors.push('MISSING_REASON: REJECT_ALL decision must provide a factual reason');
      }
      return { valid: errors.length === 0, errors };
    }

    // 3. SELECT_SUPPLIER Validation
    if (recommendation.decision === 'SELECT_SUPPLIER') {
      if (!recommendation.quoteId) {
        errors.push('MISSING_QUOTE_ID: SELECT_SUPPLIER recommendation must specify a quoteId');
      }
      if (!recommendation.supplierId) {
        errors.push('MISSING_SUPPLIER_ID: SELECT_SUPPLIER recommendation must specify a supplierId');
      }

      if (recommendation.quoteId && recommendation.supplierId) {
        const quote = quoteMap.get(recommendation.quoteId);
        if (!quote) {
          errors.push(`QUOTE_NOT_FOUND: Quote '${recommendation.quoteId}' does not exist in candidate pool`);
        } else {
          if (quote.candidateId !== recommendation.supplierId) {
            errors.push(
              `SUPPLIER_MISMATCH: Recommended supplierId '${recommendation.supplierId}' does not match quote candidate '${quote.candidateId}'`
            );
          }

          // Evaluate deterministic eligibility
          const eligibility = this.eligibilityService.evaluateQuoteEligibility(quote, rfq, {
            ...options,
            allowCrossSupplier: true,
          });
          if (!eligibility.isEligible) {
            errors.push(`INELIGIBLE_QUOTE: ${eligibility.reasons.join('; ')}`);
          }

          // Verify full quantity fulfillment
          const totalOfferedQty = quote.lineItems.reduce((acc, li) => acc + li.quotedQuantity, 0);
          if (totalOfferedQty < requestedQuantity) {
            errors.push(
              `INSUFFICIENT_QUANTITY: Selected quote offers ${totalOfferedQty} units, which is less than requested ${requestedQuantity} units`
            );
          }
        }
      }

      return { valid: errors.length === 0, errors };
    }

    // 4. SPLIT_ORDER Validation
    if (recommendation.decision === 'SPLIT_ORDER') {
      const allocations = recommendation.allocations;
      if (!allocations || !Array.isArray(allocations) || allocations.length === 0) {
        errors.push('EMPTY_ALLOCATIONS: SPLIT_ORDER decision must provide at least one allocation');
        return { valid: false, errors };
      }

      let totalAllocatedQuantity = 0;

      for (let i = 0; i < allocations.length; i++) {
        const alloc = allocations[i];
        const prefix = `Allocation[${i}]`;

        if (!alloc.quantity || alloc.quantity <= 0) {
          errors.push(`${prefix}: Quantity must be greater than zero`);
          continue;
        }

        const quote = quoteMap.get(alloc.quoteId);
        if (!quote) {
          errors.push(`${prefix}: Quote '${alloc.quoteId}' not found`);
          continue;
        }

        if (quote.candidateId !== alloc.supplierId) {
          errors.push(
            `${prefix}: Allocation supplierId '${alloc.supplierId}' does not match quote candidate '${quote.candidateId}'`
          );
        }

        // Evaluate quote eligibility
        const eligibility = this.eligibilityService.evaluateQuoteEligibility(quote, rfq, {
          ...options,
          allowCrossSupplier: true,
        });
        if (!eligibility.isEligible) {
          errors.push(`${prefix}: Quote '${alloc.quoteId}' is ineligible (${eligibility.reasons.join(', ')})`);
        }

        // Verify quantity does not exceed quote available quantity
        const quoteAvailable = quote.lineItems.reduce((acc, li) => acc + li.quotedQuantity, 0);
        if (alloc.quantity > quoteAvailable) {
          errors.push(
            `${prefix}: Allocated quantity (${alloc.quantity}) exceeds available quantity (${quoteAvailable})`
          );
        }

        // Verify MOQ satisfaction for this allocation
        const moq = options?.moqMap?.get(quote.candidateId) ?? 1;
        if (alloc.quantity < moq) {
          errors.push(
            `${prefix}: Allocated quantity (${alloc.quantity}) is below supplier minimum order quantity (${moq})`
          );
        }

        totalAllocatedQuantity += alloc.quantity;
      }

      // Quantity Conservation Invariant: SUM(allocations) === requestedQuantity
      // Round to 4 decimal places to prevent float rounding noise
      const roundedTotalAllocated = Math.round(totalAllocatedQuantity * 10000) / 10000;
      const roundedRequested = Math.round(requestedQuantity * 10000) / 10000;

      if (roundedTotalAllocated < roundedRequested) {
        errors.push(
          `UNDER_ALLOCATION: Total allocated quantity (${roundedTotalAllocated}) is less than requested quantity (${roundedRequested})`
        );
      } else if (roundedTotalAllocated > roundedRequested) {
        errors.push(
          `OVER_ALLOCATION: Total allocated quantity (${roundedTotalAllocated}) exceeds requested quantity (${roundedRequested})`
        );
      }

      return { valid: errors.length === 0, errors };
    }

    return { valid: errors.length === 0, errors };
  }
}

export const selectionValidator = new SelectionValidator();
