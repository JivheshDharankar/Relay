import {
  isLessThan,
  isPositive,
  roundMoney,
  subtractDecimals,
  toDecimal,
} from '../../../domain/procurement/decimal';
import { Quote } from '../quote/types';
import {
  AINegotiationDecision,
  NegotiationProposal,
  QuoteFactualComparison,
} from './types';

export class NegotiationAIAdvisor {
  /**
   * Evaluates factual metrics across quotes to identify commercial trade-offs and
   * generate a structured negotiation decision.
   * Pure deterministic reasoning engine backed by verifiable metrics.
   */
  public async analyzeQuotes(
    comparison: QuoteFactualComparison,
    currentRoundNumber = 1
  ): Promise<AINegotiationDecision> {
    const validQuotes = comparison.quotes.filter((q) => q.isValid && !q.isExpired);

    if (validQuotes.length === 0) {
      return {
        action: 'NO_ACTION',
        quoteId: '',
        supplierId: '',
        rfqId: comparison.rfqId,
        roundNumber: currentRoundNumber,
        strategy: 'NO_NEGOTIATION',
        requestedChanges: {},
        rationale: 'No valid or non-expired quotes available to evaluate for negotiation.',
        expectedBenefit: 'None',
      };
    }

    // 1. Single Quote Scenario: Check for fee reduction or volume optimization
    if (validQuotes.length === 1) {
      const targetQuote = validQuotes[0];
      const hasDeliveryFee = isPositive(targetQuote.deliveryFee);

      if (hasDeliveryFee && isLessThan(toDecimal(0), targetQuote.deliveryFee)) {
        return {
          action: 'NEGOTIATE',
          quoteId: targetQuote.quoteId,
          supplierId: targetQuote.candidateId,
          rfqId: comparison.rfqId,
          roundNumber: currentRoundNumber,
          strategy: 'REDUCE_DELIVERY_FEE',
          requestedChanges: {
            targetDeliveryFee: '0.00',
            notes: 'Requesting waiver or reduction of consolidated community delivery fee.',
          },
          rationale: `Single quote received. Requesting delivery fee reduction of ₹${targetQuote.deliveryFee.toFixed(2)}.`,
          expectedBenefit: `Savings of ₹${targetQuote.deliveryFee.toFixed(2)} on logistics.`,
        };
      }

      // Propose modest 5% price improvement for bulk volume
      const currentUnit = targetQuote.unitPrice;
      const targetUnit = roundMoney(toDecimal(currentUnit).times(0.95)).toNumber();
      const unitSavings = subtractDecimals(currentUnit, targetUnit).toNumber();

      return {
        action: 'NEGOTIATE',
        quoteId: targetQuote.quoteId,
        supplierId: targetQuote.candidateId,
        rfqId: comparison.rfqId,
        roundNumber: currentRoundNumber,
        strategy: 'LOWER_PRICE',
        requestedChanges: {
          targetUnitPrice: targetUnit.toFixed(2),
          notes: 'Requesting 5% consolidated volume consideration.',
        },
        rationale:
          `Single supplier commercial response at ₹${currentUnit.toFixed(2)}/unit. Proposing ₹${targetUnit.toFixed(2)}/unit for bulk aggregation.` +
          (targetQuote.isSimulated === true
            ? ' Commercial basis: simulated commercial response from discovered supplier.'
            : ''),
        expectedBenefit: `Savings of ₹${unitSavings.toFixed(2)} per unit.`,
      };
    }

    // 2. Multi-Quote Tradeoff Analysis
    const cheapest = validQuotes.find((q) => q.isLowestPrice) || validQuotes[0];
    const fastest = validQuotes.find((q) => q.isFastestDelivery) || validQuotes[0];

    // Case A: Fastest supplier is more expensive than cheapest supplier
    if (
      cheapest.quoteId !== fastest.quoteId &&
      typeof fastest.deliveryEtaHours === 'number' &&
      typeof cheapest.deliveryEtaHours === 'number' &&
      fastest.deliveryEtaHours < cheapest.deliveryEtaHours
    ) {
      // Propose fastest supplier match or approach cheapest supplier's unit price
      const priceGap = subtractDecimals(fastest.total, cheapest.total).toNumber();
      const targetUnit = cheapest.unitPrice;

      return {
        action: 'NEGOTIATE',
        quoteId: fastest.quoteId,
        supplierId: fastest.candidateId,
        rfqId: comparison.rfqId,
        roundNumber: currentRoundNumber,
        strategy: 'LOWER_PRICE',
        requestedChanges: {
          targetUnitPrice: targetUnit.toFixed(2),
          notes: 'Requesting commercial price alignment while retaining priority delivery capability.',
        },
        rationale: `Supplier ${fastest.supplierName} offers fast delivery (${fastest.deliveryEtaHours}h) but is ₹${priceGap.toFixed(2)} higher. Proposing price alignment to ₹${targetUnit.toFixed(2)}/unit.`,
        expectedBenefit: `Combines fastest turnaround with lowest price point, saving ₹${priceGap.toFixed(2)}.`,
      };
    }

    // Case B: Partial fulfillment supplier
    const partialQuote = validQuotes.find((q) => q.isPartial);
    if (partialQuote && isLessThan(partialQuote.availableQuantity, partialQuote.requestedQuantity)) {
      return {
        action: 'NEGOTIATE',
        quoteId: partialQuote.quoteId,
        supplierId: partialQuote.candidateId,
        rfqId: comparison.rfqId,
        roundNumber: currentRoundNumber,
        strategy: 'INCREASE_AVAILABLE_QUANTITY',
        requestedChanges: {
          targetQuantity: partialQuote.requestedQuantity.toString(),
          notes: 'Requesting full fulfillment of aggregated community demand.',
        },
        rationale: `Supplier ${partialQuote.supplierName} offered partial quantity (${partialQuote.availableQuantity.toString()} of ${partialQuote.requestedQuantity.toString()}). Proposing full quantity fulfillment.`,
        expectedBenefit: 'Avoids multi-supplier split fulfillment logistics.',
      };
    }

    // Case C: Cheapest supplier is also fastest -> Optimize delivery fee
    if (isPositive(cheapest.deliveryFee)) {
      return {
        action: 'NEGOTIATE',
        quoteId: cheapest.quoteId,
        supplierId: cheapest.candidateId,
        rfqId: comparison.rfqId,
        roundNumber: currentRoundNumber,
        strategy: 'REDUCE_DELIVERY_FEE',
        requestedChanges: {
          targetDeliveryFee: '0.00',
        },
        rationale: `Supplier ${cheapest.supplierName} offers lowest price. Requesting delivery fee waiver for consolidated dropoff.`,
        expectedBenefit: `Savings of ₹${cheapest.deliveryFee.toFixed(2)} in delivery charges.`,
      };
    }

    // Default: Terms are already optimal
    return {
      action: 'STOP_NEGOTIATION',
      quoteId: cheapest.quoteId,
      supplierId: cheapest.candidateId,
      rfqId: comparison.rfqId,
      roundNumber: currentRoundNumber,
      strategy: 'NO_NEGOTIATION',
      requestedChanges: {},
      rationale: `Current quote from ${cheapest.supplierName} is fully compliant and commercially optimal. No further negotiation required.`,
      expectedBenefit: 'Optimal procurement terms already established.',
    };
  }

  /**
   * Evaluates a supplier counteroffer against the initial proposal and remaining rounds.
   */
  public async evaluateCounteroffer(
    originalQuote: Quote,
    counterofferQuote: Quote,
    proposal: NegotiationProposal,
    remainingRounds: number
  ): Promise<{ outcome: 'ACCEPTABLE' | 'ANOTHER_ROUND' | 'STOPPED'; reason: string }> {
    const originalTotal = originalQuote.total;
    const counterofferTotal = counterofferQuote.total;

    // 1. Check if price improved
    const priceDifference = subtractDecimals(originalTotal, counterofferTotal).toNumber();

    // If counteroffer meets or beats proposal target or achieves >= 5% reduction
    if (
      (proposal.requestedChanges.targetUnitPrice &&
        counterofferQuote.lineItems[0] &&
        !isLessThan(
          proposal.requestedChanges.targetUnitPrice,
          counterofferQuote.lineItems[0].unitPrice
        )) ||
      (proposal.requestedChanges.targetDeliveryFee &&
        !isLessThan(proposal.requestedChanges.targetDeliveryFee, counterofferQuote.deliveryFee)) ||
      (isPositive(originalTotal) &&
        (priceDifference / originalTotal) * 100 >= 5)
    ) {
      return {
        outcome: 'ACCEPTABLE',
        reason: `Supplier accepted target terms or provided substantial improvement (Total: ₹${counterofferTotal.toFixed(2)}, saved ₹${priceDifference.toFixed(2)}).`,
      };
    }

    // 2. If supplier improved terms somewhat and more rounds are allowed
    if (isPositive(priceDifference) && remainingRounds > 0) {
      return {
        outcome: 'ANOTHER_ROUND',
        reason: `Supplier offered partial concession of ₹${priceDifference.toFixed(2)}. ${remainingRounds} negotiation round(s) remaining for further optimization.`,
      };
    }

    // 3. Otherwise stop negotiation
    return {
      outcome: 'STOPPED',
      reason:
        remainingRounds <= 0
          ? 'Maximum negotiation rounds reached.'
          : 'Supplier did not improve commercial terms; stopping negotiation.',
    };
  }
}

export const negotiationAIAdvisor = new NegotiationAIAdvisor();
