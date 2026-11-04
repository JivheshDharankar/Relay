import { z } from 'zod';
import {
  AISelectionRecommendation,
  ProposedAllocation,
  SelectionComparisonSummary,
} from './types';

export const selectionRecommendationSchema = z.object({
  decision: z.enum(['SELECT_SUPPLIER', 'SPLIT_ORDER', 'REJECT_ALL', 'REQUEST_MORE_NEGOTIATION']),
  supplierId: z.string().optional(),
  quoteId: z.string().optional(),
  allocations: z
    .array(
      z.object({
        supplierId: z.string().min(1, 'supplierId required'),
        quoteId: z.string().min(1, 'quoteId required'),
        quantity: z.number().positive('Allocation quantity must be positive'),
      })
    )
    .optional(),
  reason: z.string().min(1, 'Reason cannot be empty'),
  expectedBenefit: z
    .object({
      costSaving: z.number().optional(),
      deliveryHours: z.number().optional(),
      fulfillmentPercent: z.number().optional(),
    })
    .optional(),
});

export class SelectionAIAdvisor {
  /**
   * Evaluates factual quote metrics to formulate a structured selection recommendation.
   * Prioritizes full fulfillment at lowest cost while honoring SLA deadlines,
   * or formulates a multi-supplier split allocation when single fulfillment is impossible.
   */
  public async recommendSelection(
    comparison: SelectionComparisonSummary
  ): Promise<AISelectionRecommendation> {
    const { eligibleQuotes, requestedQuantity, fullFulfillmentQuoteIds, splitCandidates } =
      comparison;

    // 1. No Eligible Quotes -> REJECT_ALL
    if (eligibleQuotes.length === 0) {
      return {
        decision: 'REJECT_ALL',
        reason: 'No eligible supplier quotes meet the required procurement constraints or SLA deadlines.',
        expectedBenefit: { fulfillmentPercent: 0 },
      };
    }

    // 2. Full Fulfillment Quotes Available -> SELECT_SUPPLIER
    if (fullFulfillmentQuoteIds.length > 0) {
      const fullQuotes = eligibleQuotes.filter((q) => fullFulfillmentQuoteIds.includes(q.quoteId));

      // Pick lowest cost full-fulfillment quote
      let best = fullQuotes[0];
      for (const q of fullQuotes) {
        if (q.total < best.total) {
          best = q;
        }
      }

      const provenanceNote = (m: { isSimulated?: boolean }): string =>
        m.isSimulated === true
          ? ' Commercial basis: simulated commercial response from discovered supplier.'
          : '';

      // If another quote is significantly faster with a small price difference, consider trade-off
      const fastest = fullQuotes.find((q) => q.quoteId === comparison.fastestDeliveryQuoteId);
      if (
        fastest &&
        fastest.quoteId !== best.quoteId &&
        typeof fastest.deliveryEtaHours === 'number' &&
        typeof best.deliveryEtaHours === 'number' &&
        fastest.deliveryEtaHours < best.deliveryEtaHours &&
        fastest.priceDifferenceFromLowest <= 20 // Within small threshold
      ) {
        return {
          decision: 'SELECT_SUPPLIER',
          supplierId: fastest.candidateId,
          quoteId: fastest.quoteId,
          reason: `Supplier '${fastest.supplierName}' provides faster delivery (${fastest.deliveryEtaHours}h vs ${best.deliveryEtaHours}h) within acceptable price margin (+₹${fastest.priceDifferenceFromLowest.toFixed(2)}).${provenanceNote(fastest)}`,
          expectedBenefit: {
            deliveryHours: fastest.deliveryEtaHours,
            fulfillmentPercent: 100,
          },
        };
      }

      let reason: string;
      if (comparison.lineItems && comparison.lineItems.length > 1) {
        const itemsDesc = comparison.lineItems
          .map((li) => `${li.quantity} ${li.unit} ${li.productName}`)
          .join(', ');
        reason = `Supplier '${best.supplierName}' covers all ${comparison.lineItems.length} items (${itemsDesc}) at the lowest eligible total cost of ₹${best.total.toFixed(2)} with compliant SLA margin of ${best.slaMarginHours}h.${provenanceNote(best)}`;
      } else {
        reason = `Supplier '${best.supplierName}' satisfies 100% of demand (${requestedQuantity} ${comparison.unit}) at the lowest eligible total cost of ₹${best.total.toFixed(2)} with compliant SLA margin of ${best.slaMarginHours}h.${provenanceNote(best)}`;
      }

      return {
        decision: 'SELECT_SUPPLIER',
        supplierId: best.candidateId,
        quoteId: best.quoteId,
        reason,
        expectedBenefit: {
          costSaving: best.negotiatedSavings,
          deliveryHours: best.deliveryEtaHours,
          fulfillmentPercent: 100,
        },
      };
    }

    // 3. Split Order Allocation: When no single supplier can fulfill 100%
    if (splitCandidates.length >= 2) {
      // Sort split candidates by lowest unit price
      const sortedCandidates = [...splitCandidates].sort((a, b) => a.unitPrice - b.unitPrice);

      let remaining = requestedQuantity;
      const proposedAllocations: ProposedAllocation[] = [];

      for (const cand of sortedCandidates) {
        if (remaining <= 0) break;
        const allocQty = Math.min(cand.offeredQuantity, remaining);
        if (allocQty > 0) {
          proposedAllocations.push({
            supplierId: cand.candidateId,
            quoteId: cand.quoteId,
            quantity: allocQty,
          });
          remaining -= allocQty;
        }
      }

      const totalAllocated = proposedAllocations.reduce((acc, a) => acc + a.quantity, 0);

      if (totalAllocated === requestedQuantity) {
        const metricsByQuote = new Map(comparison.quotes.map((q) => [q.quoteId, q]));
        const anySimulated = proposedAllocations.some(
          (a) => metricsByQuote.get(a.quoteId)?.isSimulated === true
        );
        return {
          decision: 'SPLIT_ORDER',
          allocations: proposedAllocations,
          reason:
            `No single supplier could fulfill ${requestedQuantity} ${comparison.unit}. Formulated multi-supplier split allocation across ${proposedAllocations.length} qualified suppliers to achieve 100% demand satisfaction.` +
            (anySimulated
              ? ' Commercial basis: simulated commercial response from discovered supplier.'
              : ''),
          expectedBenefit: {
            fulfillmentPercent: 100,
          },
        };
      }
    }

    // 4. Default: Cannot satisfy full quantity -> REJECT_ALL
    return {
      decision: 'REJECT_ALL',
      reason: `Eligible candidate quotes cannot satisfy the required community quantity of ${requestedQuantity} ${comparison.unit} even with split allocation.`,
      expectedBenefit: { fulfillmentPercent: 0 },
    };
  }

  /**
   * Strictly validates the structure and schema of an AI selection recommendation.
   */
  public validateRecommendationSchema(input: unknown): AISelectionRecommendation {
    const parsed = selectionRecommendationSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(
        `Malformed AI selection recommendation: ${parsed.error.errors.map((e) => e.message).join(', ')}`
      );
    }
    return parsed.data;
  }
}

export const selectionAIAdvisor = new SelectionAIAdvisor();

