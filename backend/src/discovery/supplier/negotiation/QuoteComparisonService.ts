import { Quote } from '../quote/types';
import { RFQ } from '../rfq/types';
import { FactualQuoteMetrics, QuoteFactualComparison } from './types';

export class QuoteComparisonService {
  /**
   * Performs deterministic, factual quote comparison without AI reasoning or hallucinations.
   * Compares pricing, delivery SLAs, quantity fulfillment, and hard constraints.
   */
  public compareQuotes(
    rfq: RFQ,
    quotes: Quote[],
    supplierReliabilityMap?: Map<string, number>,
    referenceTime: Date = new Date()
  ): QuoteFactualComparison {
    const hardConstraintViolations: { quoteId: string; reason: string }[] = [];
    const slaDeadline = rfq.deliveryDeadline ?? new Date(Date.now() + 86400000);

    // 1. Compute factual metrics for each quote
    const computedMetrics: FactualQuoteMetrics[] = quotes.map((quote) => {
      const isExpired = quote.validUntil.getTime() <= referenceTime.getTime();
      const isValid = quote.status === 'VALID' || quote.status === 'PARTIAL';

      // Verify SLA Delivery Compliance
      let isSlaCompliant = false;
      if (quote.confirmedDeliveryEta) {
        isSlaCompliant = quote.confirmedDeliveryEta.getTime() <= slaDeadline.getTime();
      } else if (typeof quote.deliveryEtaHours === 'number') {
        const estimatedDelivery = new Date(
          quote.receivedAt.getTime() + quote.deliveryEtaHours * 3600 * 1000
        );
        isSlaCompliant = estimatedDelivery.getTime() <= slaDeadline.getTime();
      }

      // Record hard constraint violations
      if (quote.status === 'INVALID') {
        hardConstraintViolations.push({
          quoteId: quote.id,
          reason: `QUOTE_STATUS_INVALID: ${quote.rejectionReasons?.join(', ') || 'Validation failed'}`,
        });
      } else if (isExpired) {
        hardConstraintViolations.push({
          quoteId: quote.id,
          reason: `QUOTE_EXPIRED: Quote expired at ${quote.validUntil.toISOString()}`,
        });
      } else if (!isSlaCompliant) {
        hardConstraintViolations.push({
          quoteId: quote.id,
          reason: `SLA_DELIVERY_DEADLINE_EXCEEDED: Promised delivery exceeds RFQ deadline ${slaDeadline.toISOString()}`,
        });
      }

      const unitPrice = quote.lineItems[0]?.unitPrice ?? 0;
      const availableQuantity = quote.lineItems.reduce(
        (acc, li) => acc + li.quotedQuantity,
        0
      );
      const requestedQuantity = quote.lineItems.reduce(
        (acc, li) => acc + li.requestedQuantity,
        0
      );
      const isPartial =
        quote.status === 'PARTIAL' || quote.lineItems.some((li) => li.isPartial);

      const reliability = supplierReliabilityMap?.get(quote.candidateId);

      return {
        quoteId: quote.id,
        candidateId: quote.candidateId,
        supplierName: quote.supplierName,
        total: quote.total,
        unitPrice,
        deliveryFee: quote.deliveryFee,
        tax: quote.tax,
        availableQuantity,
        requestedQuantity,
        isPartial,
        deliveryEtaHours: quote.deliveryEtaHours,
        isSlaCompliant,
        slaDeadline,
        validUntil: quote.validUntil,
        isExpired,
        isValid,
        status: quote.status,
        supplierReliabilityScore: reliability,
        priceDifferenceFromLowest: 0,
        isLowestPrice: false,
        isFastestDelivery: false,
        isSimulated: quote.isSimulated,
      };
    });

    // 2. Identify eligible pool for comparative ranking
    const eligibleQuotes = computedMetrics.filter(
      (m) => m.isValid && m.isSlaCompliant && !m.isExpired
    );

    const comparisonPool = eligibleQuotes.length > 0 ? eligibleQuotes : computedMetrics;

    // 3. Find lowest price and fastest delivery
    let lowestTotal = comparisonPool[0]?.total;
    let fastestEta = comparisonPool[0]?.deliveryEtaHours;
    let cheapestQuoteId = comparisonPool[0]?.quoteId;
    let fastestQuoteId = comparisonPool[0]?.quoteId;
    let bestFulfillmentQuoteId = comparisonPool[0]?.quoteId;

    for (const m of comparisonPool) {
      if (lowestTotal === undefined || m.total < lowestTotal) {
        lowestTotal = m.total;
        cheapestQuoteId = m.quoteId;
      }
      if (
        typeof m.deliveryEtaHours === 'number' &&
        (fastestEta === undefined || m.deliveryEtaHours < fastestEta)
      ) {
        fastestEta = m.deliveryEtaHours;
        fastestQuoteId = m.quoteId;
      }
      // Best fulfillment prioritizes full fulfillment over partial
      if (!m.isPartial && (!bestFulfillmentQuoteId || comparisonPool.find(c => c.quoteId === bestFulfillmentQuoteId)?.isPartial)) {
        bestFulfillmentQuoteId = m.quoteId;
      }
    }

    // 4. Decorate metrics with comparative flags
    for (const m of computedMetrics) {
      if (lowestTotal !== undefined) {
        m.priceDifferenceFromLowest = m.total - lowestTotal;
        m.isLowestPrice = m.total === lowestTotal;
      }
      if (typeof m.deliveryEtaHours === 'number' && fastestEta !== undefined) {
        m.isFastestDelivery = m.deliveryEtaHours === fastestEta;
      }
    }

    return {
      rfqId: rfq.id,
      quoteCount: quotes.length,
      quotes: computedMetrics,
      cheapestQuoteId,
      fastestQuoteId,
      bestFulfillmentQuoteId,
      hardConstraintViolations,
    };
  }
}

export const quoteComparisonService = new QuoteComparisonService();
