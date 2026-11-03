import { Quote } from '../quote/types';
import { RFQ } from '../rfq/types';
import { QuoteEligibilityService, quoteEligibilityService } from './QuoteEligibilityService';
import { QuoteSelectionMetrics, SelectionComparisonSummary } from './types';

export class QuoteSelectionComparator {
  constructor(
    private readonly eligibilityService: QuoteEligibilityService = quoteEligibilityService
  ) {}

  /**
   * Generates deterministic, normalized factual comparison metrics across candidate quotes
   * for an RFQ, strictly avoiding any subjective or unverified assumptions.
   */
  public generateComparisonSummary(
    rfq: RFQ,
    quotes: Quote[],
    options?: {
      moqMap?: Map<string, number>;
      supplierDistances?: Map<string, number>;
      negotiatedSavingsMap?: Map<string, number>;
      referenceTime?: Date;
    }
  ): SelectionComparisonSummary {
    const requestedQuantity = rfq.lineItems.reduce((acc, li) => acc + li.quantity, 0);
    const unit = rfq.lineItems[0]?.unit ?? 'units';
    const referenceTime = options?.referenceTime ?? new Date();

    // 1. Evaluate eligibility for all quotes
    const eligibilityResults = quotes.map((q) =>
      this.eligibilityService.evaluateQuoteEligibility(q, rfq, {
        moqMap: options?.moqMap,
        referenceTime,
        allowCrossSupplier: true,
      })
    );
    const eligibilityMap = new Map(eligibilityResults.map((r) => [r.quoteId, r]));

    // 2. Compute per-quote factual metrics
    const quoteMetrics: QuoteSelectionMetrics[] = quotes.map((quote) => {
      const eligibility = eligibilityMap.get(quote.id);
      const isEligible = eligibility?.isEligible ?? false;
      const eligibilityReasons = eligibility?.reasons ?? [];

      const primaryLine = quote.lineItems[0];
      const unitPrice = primaryLine?.unitPrice ?? 0;
      const offeredQuantity = quote.lineItems.reduce((acc, li) => acc + li.quotedQuantity, 0);
      const isPartial = quote.status === 'PARTIAL' || offeredQuantity < requestedQuantity;
      const moq = options?.moqMap?.get(quote.candidateId) ?? 1;
      const moqSatisfied = offeredQuantity >= moq;

      const slaMarginHours = eligibility?.remainingSlaHours ?? 0;
      const isSlaCompliant = slaMarginHours > 0;

      const distance = options?.supplierDistances?.get(quote.candidateId);
      const negotiatedSavings = options?.negotiatedSavingsMap?.get(quote.id) ?? 0;

      return {
        quoteId: quote.id,
        candidateId: quote.candidateId,
        supplierName: quote.supplierName,
        unitPrice,
        total: quote.total,
        priceDifferenceFromLowest: 0, // Calculated in pass 2
        deliveryFee: quote.deliveryFee,
        deliveryEtaHours: quote.deliveryEtaHours,
        slaMarginHours,
        isSlaCompliant,
        availableQuantity: offeredQuantity,
        requestedQuantity,
        offeredQuantity,
        isPartial,
        moq,
        moqSatisfied,
        negotiatedSavings,
        supplierDistanceKm: distance,
        isEligible,
        eligibilityReasons,
        isSimulated: quote.isSimulated,
      };
    });

    const eligibleQuotes = quoteMetrics.filter((m) => m.isEligible);

    // 3. Find lowest cost and fastest delivery among eligible quotes
    let lowestCostQuoteId: string | undefined;
    let fastestDeliveryQuoteId: string | undefined;
    let bestSlaMarginQuoteId: string | undefined;

    let lowestTotal: number | undefined;
    let fastestEta: number | undefined;
    let maxSlaMargin: number | undefined;

    for (const m of eligibleQuotes) {
      if (lowestTotal === undefined || m.total < lowestTotal) {
        lowestTotal = m.total;
        lowestCostQuoteId = m.quoteId;
      }
      if (
        typeof m.deliveryEtaHours === 'number' &&
        (fastestEta === undefined || m.deliveryEtaHours < fastestEta)
      ) {
        fastestEta = m.deliveryEtaHours;
        fastestDeliveryQuoteId = m.quoteId;
      }
      if (maxSlaMargin === undefined || m.slaMarginHours > maxSlaMargin) {
        maxSlaMargin = m.slaMarginHours;
        bestSlaMarginQuoteId = m.quoteId;
      }
    }

    // Pass 2: Decorate price difference from lowest eligible total
    const baselineTotal = lowestTotal ?? (quoteMetrics[0]?.total || 0);
    for (const m of quoteMetrics) {
      m.priceDifferenceFromLowest = Math.max(0, Math.round((m.total - baselineTotal) * 100) / 100);
    }

    const fullFulfillmentQuoteIds = eligibleQuotes
      .filter((m) => !m.isPartial && m.offeredQuantity >= requestedQuantity)
      .map((m) => m.quoteId);

    const splitCandidates = eligibleQuotes.filter(
      (m) => m.isPartial && m.offeredQuantity > 0 && m.offeredQuantity < requestedQuantity
    );

    return {
      rfqId: rfq.id,
      requestedQuantity,
      unit,
      quotes: quoteMetrics,
      eligibleQuotes,
      lowestCostQuoteId,
      fastestDeliveryQuoteId,
      bestSlaMarginQuoteId,
      fullFulfillmentQuoteIds,
      splitCandidates,
    };
  }
}

export const quoteSelectionComparator = new QuoteSelectionComparator();
