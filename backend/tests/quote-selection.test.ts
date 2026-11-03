import { describe, it, expect, beforeEach } from 'vitest';
import { RFQService } from '../src/discovery/supplier/rfq/RFQService';
import { QuoteNormalizationService } from '../src/discovery/supplier/quote/QuoteNormalizationService';
import { SupplierResponseService } from '../src/discovery/supplier/quote/provider/SupplierResponseService';
import { MockSupplierResponseProvider } from '../src/discovery/supplier/quote/provider/MockSupplierResponseProvider';
import { SupplierCandidate } from '../src/discovery/supplier/types';
import { RFQ } from '../src/discovery/supplier/rfq/types';
import { Quote } from '../src/discovery/supplier/quote/types';
import { eventBus } from '../src/events';
import { toolRegistry } from '../src/agent/tools';
import {
  QuoteEligibilityService,
  QuoteSelectionComparator,
  SelectionAIAdvisor,
  SelectionValidator,
  SelectionValidationError,
  AllocationService,
  PurchaseOrderService,
  ProcurementCommitmentService,
  purchaseOrderMessageBuilder,
  assertLegalCommitmentTransition,
  canTransitionCommitment,
  CommitmentStateMachineError,
  AISelectionRecommendation,
} from '../src/discovery/supplier/selection';
import {
  procurementCommitmentService as defaultCommitmentService,
  rfqService as defaultRfqService,
  quoteNormalizationService as defaultQuoteService,
} from '../src/discovery/supplier';

describe('Phase 6: Quote Selection, Procurement Commitment & Multi-Supplier Allocation', () => {
  let rfqService: RFQService;
  let quoteNormalizationService: QuoteNormalizationService;
  let supplierResponseService: SupplierResponseService;
  let eligibilityService: QuoteEligibilityService;
  let comparator: QuoteSelectionComparator;
  let advisor: SelectionAIAdvisor;
  let validator: SelectionValidator;
  let allocationService: AllocationService;
  let poService: PurchaseOrderService;
  let commitmentService: ProcurementCommitmentService;

  let candidateA: SupplierCandidate;
  let candidateB: SupplierCandidate;
  let candidateC: SupplierCandidate;

  let rfqA: RFQ;
  let rfqB: RFQ;
  let rfqC: RFQ;

  let quoteA: Quote; // 1,000 units @ ₹58 = ₹58,000 + ₹200 delivery = ₹58,200 (ETA 8h)
  let quoteB: Quote; // 1,000 units @ ₹55 = ₹55,000 + ₹500 delivery = ₹55,500 (ETA 11h)
  let quoteC_partial: Quote; // 600 units @ ₹52 = ₹31,200 + ₹300 delivery = ₹31,500 (ETA 6h)
  let quoteD_partial: Quote; // 400 units @ ₹54 = ₹21,600 + ₹250 delivery = ₹21,850 (ETA 7h)

  beforeEach(async () => {
    rfqService = new RFQService();
    quoteNormalizationService = new QuoteNormalizationService();

    const mockResponseProvider = new MockSupplierResponseProvider(rfqService);
    supplierResponseService = new SupplierResponseService(rfqService);
    supplierResponseService.registerProvider(mockResponseProvider);

    eligibilityService = new QuoteEligibilityService();
    comparator = new QuoteSelectionComparator(eligibilityService);
    advisor = new SelectionAIAdvisor();
    validator = new SelectionValidator(eligibilityService);
    allocationService = new AllocationService();
    poService = new PurchaseOrderService();
    commitmentService = new ProcurementCommitmentService(
      rfqService,
      quoteNormalizationService,
      comparator,
      advisor,
      validator,
      allocationService,
      poService
    );

    // Seed Qualified Candidates
    candidateA = {
      id: 'cand_wholesaler_alpha',
      name: 'Alpha Wholesale Grains',
      address: 'Gultekdi Market Yard, Pune',
      latitude: 18.496,
      longitude: 73.868,
      categories: ['grain_wholesaler'],
      email: 'orders@alphagrains.com',
      phone: '+919876543201',
    };

    candidateB = {
      id: 'cand_mart_beta',
      name: 'Beta Bulk Mart',
      address: 'Hadapsar Industrial Estate, Pune',
      latitude: 18.502,
      longitude: 73.928,
      categories: ['grain_wholesaler'],
      email: 'sales@betabulk.com',
      phone: '+919876543202',
    };

    candidateC = {
      id: 'cand_agro_gamma',
      name: 'Gamma Agro Cooperative',
      address: 'Phaltan Rural Depot, Pune Division',
      latitude: 18.512,
      longitude: 73.858,
      categories: ['grain_wholesaler'],
      email: 'contact@gammaagro.org',
      phone: '+919876543203',
    };

    // 12-hour SLA deadline
    const now = new Date();
    const slaDeadline = new Date(now.getTime() + 12 * 3600 * 1000);
    const quoteDeadline = new Date(now.getTime() + 4 * 3600 * 1000);

    // Create RFQs for 1,000 KG of Wheat
    rfqA = await rfqService.createRFQ({
      candidate: candidateA,
      lineItems: [{ productName: 'Sharbati Wheat', quantity: 1000, unit: 'KG' }],
      deliveryArea: 'Greenview Residency Community Service Area',
      deliveryDeadline: slaDeadline,
      quoteDeadline,
    });

    rfqB = await rfqService.createRFQ({
      candidate: candidateB,
      lineItems: [{ productName: 'Sharbati Wheat', quantity: 1000, unit: 'KG' }],
      deliveryArea: 'Greenview Residency Community Service Area',
      deliveryDeadline: slaDeadline,
      quoteDeadline,
    });

    rfqC = await rfqService.createRFQ({
      candidate: candidateC,
      lineItems: [{ productName: 'Sharbati Wheat', quantity: 1000, unit: 'KG' }],
      deliveryArea: 'Greenview Residency Community Service Area',
      deliveryDeadline: slaDeadline,
      quoteDeadline,
    });

    // Ingest & Normalize Quote A (1,000kg @ ₹58/kg + ₹200 fee = ₹58,200, ETA 8h)
    const respA = await supplierResponseService.ingestResponse({
      rfqId: rfqA.id,
      candidateId: candidateA.id,
      supplierName: candidateA.name,
      channel: 'manual',
      lineItems: [{ productName: 'Sharbati Wheat', quotedQuantity: 1000, unit: 'KG', unitPrice: 58 }],
      deliveryFee: 200,
      deliveryEtaHours: 8,
      validUntil: new Date(now.getTime() + 24 * 3600 * 1000),
    });
    quoteA = (await quoteNormalizationService.normalizeResponse(respA)).quote;

    // Ingest & Normalize Quote B (1,000kg @ ₹55/kg + ₹500 fee = ₹55,500, ETA 11h)
    const respB = await supplierResponseService.ingestResponse({
      rfqId: rfqB.id,
      candidateId: candidateB.id,
      supplierName: candidateB.name,
      channel: 'manual',
      lineItems: [{ productName: 'Sharbati Wheat', quotedQuantity: 1000, unit: 'KG', unitPrice: 55 }],
      deliveryFee: 500,
      deliveryEtaHours: 11,
      validUntil: new Date(now.getTime() + 24 * 3600 * 1000),
    });
    quoteB = (await quoteNormalizationService.normalizeResponse(respB)).quote;

    // Ingest & Normalize Quote C Partial (600kg @ ₹52/kg + ₹300 fee = ₹31,500, ETA 6h)
    const respC = await supplierResponseService.ingestResponse({
      rfqId: rfqA.id,
      candidateId: candidateA.id,
      supplierName: candidateA.name,
      channel: 'manual',
      lineItems: [{ productName: 'Sharbati Wheat', quotedQuantity: 600, unit: 'KG', unitPrice: 52 }],
      deliveryFee: 300,
      deliveryEtaHours: 6,
      validUntil: new Date(now.getTime() + 24 * 3600 * 1000),
    });
    quoteC_partial = (await quoteNormalizationService.normalizeResponse(respC)).quote;

    // Ingest & Normalize Quote D Partial (400kg @ ₹54/kg + ₹250 fee = ₹21,850, ETA 7h)
    const respD = await supplierResponseService.ingestResponse({
      rfqId: rfqB.id,
      candidateId: candidateB.id,
      supplierName: candidateB.name,
      channel: 'manual',
      lineItems: [{ productName: 'Sharbati Wheat', quotedQuantity: 400, unit: 'KG', unitPrice: 54 }],
      deliveryFee: 250,
      deliveryEtaHours: 7,
      validUntil: new Date(now.getTime() + 24 * 3600 * 1000),
    });
    quoteD_partial = (await quoteNormalizationService.normalizeResponse(respD)).quote;
  });

  // =========================================================================
  // 1. QUOTE ELIGIBILITY (Tests 1 - 9)
  // =========================================================================
  describe('1. Deterministic Quote Eligibility', () => {
    it('1. Valid quote with full fulfillment and compliant SLA is accepted as eligible', () => {
      const result = eligibilityService.evaluateQuoteEligibility(quoteA, rfqA);
      expect(result.isEligible).toBe(true);
      expect(result.reasons.length).toBe(0);
      expect(result.remainingSlaHours).toBeGreaterThan(0);
    });

    it('2. Expired quote is rejected with QUOTE_EXPIRED', () => {
      const expiredQuote = {
        ...quoteA,
        validUntil: new Date(Date.now() - 3600000),
      };
      const result = eligibilityService.evaluateQuoteEligibility(expiredQuote, rfqA);
      expect(result.isEligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('QUOTE_EXPIRED'))).toBe(true);
    });

    it('3. Invalid quote status is rejected with QUOTE_INVALID', () => {
      const invalidQuote = {
        ...quoteA,
        status: 'INVALID' as const,
        rejectionReasons: ['INVALID_UNIT'],
      };
      const result = eligibilityService.evaluateQuoteEligibility(invalidQuote, rfqA);
      expect(result.isEligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('QUOTE_INVALID'))).toBe(true);
    });

    it('4. Candidate supplier mismatch is rejected with SUPPLIER_MISMATCH', () => {
      // Quote A belongs to candidateA, evaluate against rfqB (candidateB)
      const result = eligibilityService.evaluateQuoteEligibility(quoteA, rfqB);
      expect(result.isEligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('SUPPLIER_MISMATCH'))).toBe(true);
    });

    it('5. Inactive or cancelled RFQ is rejected with RFQ_INACTIVE', () => {
      const cancelledRfq = { ...rfqA, status: 'CANCELLED' as const };
      const result = eligibilityService.evaluateQuoteEligibility(quoteA, cancelledRfq);
      expect(result.isEligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('RFQ_INACTIVE'))).toBe(true);
    });

    it('6. SLA deadline violation is rejected with SLA_DEADLINE_EXCEEDED', () => {
      // 15 hours delivery turnaround vs 12-hour deadline
      const slowQuote = { ...quoteA, deliveryEtaHours: 15 };
      const result = eligibilityService.evaluateQuoteEligibility(slowQuote, rfqA);
      expect(result.isEligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('SLA_DEADLINE_EXCEEDED'))).toBe(true);
    });

    it('7. MOQ violation is rejected with MOQ_VIOLATION', () => {
      // Candidate requires MOQ of 1,200 KG, quote offers only 1,000 KG
      const moqMap = new Map([[candidateA.id, 1200]]);
      const result = eligibilityService.evaluateQuoteEligibility(quoteA, rfqA, { moqMap });
      expect(result.isEligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('MOQ_VIOLATION'))).toBe(true);
    });

    it('8. Insufficient zero or negative quantity is rejected with INSUFFICIENT_QUANTITY', () => {
      const zeroQtyQuote = {
        ...quoteA,
        lineItems: [{ ...quoteA.lineItems[0], quotedQuantity: 0 }],
      };
      const result = eligibilityService.evaluateQuoteEligibility(zeroQtyQuote, rfqA);
      expect(result.isEligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('INSUFFICIENT_QUANTITY'))).toBe(true);
    });

    it('9. Wrong RFQ quote reference is rejected with WRONG_RFQ', () => {
      const wrongRfqQuote = { ...quoteA, rfqId: 'rfq_mismatched_other' };
      const result = eligibilityService.evaluateQuoteEligibility(wrongRfqQuote, rfqA);
      expect(result.isEligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('WRONG_RFQ'))).toBe(true);
    });
  });

  // =========================================================================
  // 2. COMPARISON & FACTUAL METRICS (Tests 10 - 15)
  // =========================================================================
  describe('2. Quote Comparison & Optimization Layer', () => {
    it('10. Lowest cost quote is identified deterministically without LLM arithmetic', () => {
      const summary = comparator.generateComparisonSummary(rfqA, [quoteA, quoteB]);
      expect(summary.lowestCostQuoteId).toBe(quoteB.id); // ₹55,500 < ₹58,200
    });

    it('11. Fastest delivery turnaround is identified deterministically', () => {
      const summary = comparator.generateComparisonSummary(rfqA, [quoteA, quoteB]);
      expect(summary.fastestDeliveryQuoteId).toBe(quoteA.id); // 8h < 11h
    });

    it('12. SLA margins are calculated accurately from deadline', () => {
      const summary = comparator.generateComparisonSummary(rfqA, [quoteA, quoteB]);
      const metricA = summary.quotes.find((q) => q.quoteId === quoteA.id)!;
      const metricB = summary.quotes.find((q) => q.quoteId === quoteB.id)!;

      expect(metricA.slaMarginHours).toBe(4); // 12h - 8h = 4h
      expect(metricB.slaMarginHours).toBe(1); // 12h - 11h = 1h
    });

    it('13. Distinguishes full-fulfillment quotes from partial split candidates', () => {
      const summary = comparator.generateComparisonSummary(rfqA, [quoteA, quoteC_partial]);
      expect(summary.fullFulfillmentQuoteIds).toContain(quoteA.id);
      expect(summary.splitCandidates.map((c) => c.quoteId)).toContain(quoteC_partial.id);
    });

    it('14. Unknown supplier facts remain undefined and are never fabricated', () => {
      const summary = comparator.generateComparisonSummary(rfqA, [quoteA]);
      expect(summary.quotes[0].supplierDistanceKm).toBeUndefined();
    });

    it('15. Exact Decimal price difference from lowest is computed cleanly', () => {
      const summary = comparator.generateComparisonSummary(rfqA, [quoteA, quoteB]);
      const metricA = summary.quotes.find((q) => q.quoteId === quoteA.id)!;
      // ₹58,200 - ₹55,500 = ₹2,700
      expect(metricA.priceDifferenceFromLowest).toBe(2700);
    });
  });

  // =========================================================================
  // 3. SELECTION AI ADVISOR (Tests 16 - 20)
  // =========================================================================
  describe('3. Selection AI Advisor Reasoning', () => {
    it('16. Recommends SELECT_SUPPLIER for lowest eligible total with compliant SLA', async () => {
      const summary = comparator.generateComparisonSummary(rfqA, [quoteA, quoteB]);
      const recommendation = await advisor.recommendSelection(summary);

      expect(recommendation.decision).toBe('SELECT_SUPPLIER');
      expect(recommendation.quoteId).toBe(quoteB.id); // Lowest total ₹55,500
      expect(recommendation.supplierId).toBe(candidateB.id);
      expect(recommendation.reason).toContain('100% of demand');
    });

    it('17. Recommends SPLIT_ORDER when single suppliers cannot fulfill 100% demand', async () => {
      // 600kg + 400kg = 1,000kg
      const summary = comparator.generateComparisonSummary(rfqA, [quoteC_partial, quoteD_partial]);
      const recommendation = await advisor.recommendSelection(summary);

      expect(recommendation.decision).toBe('SPLIT_ORDER');
      expect(recommendation.allocations?.length).toBe(2);

      const totalAllocated = recommendation.allocations!.reduce((acc, a) => acc + a.quantity, 0);
      expect(totalAllocated).toBe(1000);
    });

    it('18. Recommends REJECT_ALL when no quotes are eligible', async () => {
      const expiredQuote = { ...quoteA, validUntil: new Date(Date.now() - 3600000) };
      const summary = comparator.generateComparisonSummary(rfqA, [expiredQuote]);
      const recommendation = await advisor.recommendSelection(summary);

      expect(recommendation.decision).toBe('REJECT_ALL');
      expect(recommendation.reason).toContain('No eligible supplier quotes');
    });

    it('19. Considers speed trade-off when price gap is minor', async () => {
      // Create quote B2 where price is only ₹10 cheaper than A, but A is 3 hours faster
      const quoteB_close = {
        ...quoteB,
        id: 'quote_b_close',
        total: 58190, // Only ₹10 less than A (58,200)
        priceDifferenceFromLowest: 0,
      };
      quoteNormalizationService['quotes'].set(quoteB_close.id, quoteB_close as Quote);

      const summary = comparator.generateComparisonSummary(rfqA, [quoteA, quoteB_close as Quote]);
      const recommendation = await advisor.recommendSelection(summary);

      expect(recommendation.decision).toBe('SELECT_SUPPLIER');
      expect(recommendation.quoteId).toBe(quoteA.id); // Picked faster delivery
    });

    it('20. Schema validation rejects malformed recommendation output', () => {
      expect(() =>
        advisor.validateRecommendationSchema({
          decision: 'INVALID_DECISION_TYPE',
          reason: 'Test',
        })
      ).toThrow(/Malformed AI selection recommendation/i);
    });
  });

  // =========================================================================
  // 4. DETERMINISTIC SELECTION VALIDATOR (Tests 21 - 27)
  // =========================================================================
  describe('4. Deterministic Selection Validator', () => {
    it('21. Valid SELECT_SUPPLIER recommendation passes validation', () => {
      const recommendation: AISelectionRecommendation = {
        decision: 'SELECT_SUPPLIER',
        supplierId: candidateB.id,
        quoteId: quoteB.id,
        reason: 'Lowest cost supplier',
      };
      const result = validator.validateRecommendation(recommendation, rfqA, [quoteA, quoteB]);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('22. Unknown supplier or quote ID is rejected', () => {
      const recommendation: AISelectionRecommendation = {
        decision: 'SELECT_SUPPLIER',
        supplierId: 'cand_unknown_phantom',
        quoteId: 'quote_unknown_phantom',
        reason: 'Phantom test',
      };
      const result = validator.validateRecommendation(recommendation, rfqA, [quoteA]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('QUOTE_NOT_FOUND'))).toBe(true);
    });

    it('23. AI recommendation choosing an ineligible quote is rejected', () => {
      const expiredQuote = { ...quoteA, validUntil: new Date(Date.now() - 3600000) };
      const recommendation: AISelectionRecommendation = {
        decision: 'SELECT_SUPPLIER',
        supplierId: candidateA.id,
        quoteId: expiredQuote.id,
        reason: 'Choosing expired quote',
      };
      const result = validator.validateRecommendation(recommendation, rfqA, [expiredQuote]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('INELIGIBLE_QUOTE'))).toBe(true);
    });

    it('24. Valid SPLIT_ORDER allocation mathematically satisfying demand passes', () => {
      const recommendation: AISelectionRecommendation = {
        decision: 'SPLIT_ORDER',
        allocations: [
          { supplierId: candidateA.id, quoteId: quoteC_partial.id, quantity: 600 },
          { supplierId: candidateB.id, quoteId: quoteD_partial.id, quantity: 400 },
        ],
        reason: 'Split fulfillment',
      };
      const result = validator.validateRecommendation(recommendation, rfqA, [
        quoteC_partial,
        quoteD_partial,
      ]);
      expect(result.valid).toBe(true);
    });

    it('25. Under-allocation is strictly rejected with UNDER_ALLOCATION', () => {
      const recommendation: AISelectionRecommendation = {
        decision: 'SPLIT_ORDER',
        allocations: [
          { supplierId: candidateA.id, quoteId: quoteC_partial.id, quantity: 500 }, // 500 + 400 = 900 < 1000
          { supplierId: candidateB.id, quoteId: quoteD_partial.id, quantity: 400 },
        ],
        reason: 'Under-allocation test',
      };
      const result = validator.validateRecommendation(recommendation, rfqA, [
        quoteC_partial,
        quoteD_partial,
      ]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('UNDER_ALLOCATION'))).toBe(true);
    });

    it('26. Over-allocation is strictly rejected with OVER_ALLOCATION', () => {
      const recommendation: AISelectionRecommendation = {
        decision: 'SPLIT_ORDER',
        allocations: [
          { supplierId: candidateA.id, quoteId: quoteC_partial.id, quantity: 600 }, // 600 + 500 = 1100 > 1000
          { supplierId: candidateB.id, quoteId: quoteD_partial.id, quantity: 500 },
        ],
        reason: 'Over-allocation test',
      };
      const result = validator.validateRecommendation(recommendation, rfqA, [
        quoteC_partial,
        quoteD_partial,
      ]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('OVER_ALLOCATION'))).toBe(true);
    });

    it('27. Allocation exceeding supplier available quantity is rejected', () => {
      const recommendation: AISelectionRecommendation = {
        decision: 'SPLIT_ORDER',
        allocations: [
          { supplierId: candidateA.id, quoteId: quoteC_partial.id, quantity: 700 }, // Offered only 600
          { supplierId: candidateB.id, quoteId: quoteD_partial.id, quantity: 300 },
        ],
        reason: 'Exceeding quote available',
      };
      const result = validator.validateRecommendation(recommendation, rfqA, [
        quoteC_partial,
        quoteD_partial,
      ]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('exceeds available quantity'))).toBe(true);
    });
  });

  // =========================================================================
  // 5. MULTI-SUPPLIER ALLOCATION & FINANCIALS (Tests 28 - 31)
  // =========================================================================
  describe('5. Multi-Supplier Allocation & Exact Decimal Arithmetic', () => {
    it('28. Sum of split allocation quantities strictly equals requested quantity', () => {
      const quoteMap = new Map([
        [quoteC_partial.id, quoteC_partial],
        [quoteD_partial.id, quoteD_partial],
      ]);
      const plan = allocationService.calculateAllocations(
        'commit_split_1',
        [
          { supplierId: candidateA.id, quoteId: quoteC_partial.id, quantity: 600 },
          { supplierId: candidateB.id, quoteId: quoteD_partial.id, quantity: 400 },
        ],
        quoteMap
      );

      const totalQty = plan.allocations.reduce((acc, a) => acc + a.allocatedQuantity, 0);
      expect(totalQty).toBe(1000);
    });

    it('29. Financial subtotals per allocation are calculated with Decimal precision', () => {
      const quoteMap = new Map([
        [quoteC_partial.id, quoteC_partial],
        [quoteD_partial.id, quoteD_partial],
      ]);
      const plan = allocationService.calculateAllocations(
        'commit_split_1',
        [
          { supplierId: candidateA.id, quoteId: quoteC_partial.id, quantity: 600 },
          { supplierId: candidateB.id, quoteId: quoteD_partial.id, quantity: 400 },
        ],
        quoteMap
      );

      // Alloc 1: 600 * 52 = 31,200 subtotal, 300 delivery = 31,500 total
      expect(plan.allocations[0].lineSubtotal).toBe(31200);
      expect(plan.allocations[0].totalAmount).toBe(31500);

      // Alloc 2: 400 * 54 = 21,600 subtotal, 250 delivery = 21,850 total
      expect(plan.allocations[1].lineSubtotal).toBe(21600);
      expect(plan.allocations[1].totalAmount).toBe(21850);
    });

    it('30. Sum of all supplier totals exactly equals community procurement grand total', () => {
      const quoteMap = new Map([
        [quoteC_partial.id, quoteC_partial],
        [quoteD_partial.id, quoteD_partial],
      ]);
      const plan = allocationService.calculateAllocations(
        'commit_split_1',
        [
          { supplierId: candidateA.id, quoteId: quoteC_partial.id, quantity: 600 },
          { supplierId: candidateB.id, quoteId: quoteD_partial.id, quantity: 400 },
        ],
        quoteMap
      );

      const sumTotals = plan.allocations.reduce((acc, a) => acc + a.totalAmount, 0);
      // 31,500 + 21,850 = 53,350
      expect(plan.financials.total).toBe(sumTotals);
      expect(plan.financials.total).toBe(53350);
    });

    it('31. Decimal math eliminates JavaScript float rounding noise', () => {
      // Custom quote with fractional unit price (₹53.33) and fractional quantity (333.3333 KG)
      const fractionalQuote: Quote = {
        ...quoteA,
        id: 'quote_fractional',
        lineItems: [
          {
            productName: 'Sharbati Wheat',
            quotedQuantity: 333.3333,
            requestedQuantity: 333.3333,
            isPartial: false,
            unit: 'KG',
            unitPrice: 53.33,
            lineSubtotal: 17776.66,
          },
        ],
        deliveryFee: 150.55,
        tax: 0,
        otherCharges: 0,
        total: 17927.21,
      };

      const quoteMap = new Map([[fractionalQuote.id, fractionalQuote]]);
      const plan = allocationService.calculateAllocations(
        'commit_frac',
        [{ supplierId: candidateA.id, quoteId: fractionalQuote.id, quantity: 333.3333 }],
        quoteMap
      );

      expect(plan.financials.subtotal).toBe(17776.66);
      expect(plan.financials.total).toBe(17927.21);
    });
  });

  // =========================================================================
  // 6. PROCUREMENT COMMITMENT & STATE MACHINE (Tests 32 - 37)
  // =========================================================================
  describe('6. Procurement Commitment Lifecycle & State Machine', () => {
    it('32. Valid commitment is created with COMMITTED status advancing to READY_FOR_PAYMENT', async () => {
      const { commitment, purchaseOrders } = await commitmentService.createCommitment({
        rfqId: rfqA.id,
        recommendation: {
          decision: 'SELECT_SUPPLIER',
          supplierId: candidateA.id,
          quoteId: quoteA.id,
          reason: 'Best terms',
        },
      });

      expect(commitment.id).toBeDefined();
      expect(commitment.status).toBe('READY_FOR_PAYMENT');
      expect(commitment.committedQuantity).toBe(1000);
      expect(commitment.financials.total).toBe(58200);
      expect(purchaseOrders.length).toBe(1);
    });

    it('33. Duplicate commitment requests are safely deduplicated (idempotency)', async () => {
      const input = {
        rfqId: rfqA.id,
        recommendation: {
          decision: 'SELECT_SUPPLIER' as const,
          supplierId: candidateA.id,
          quoteId: quoteA.id,
          reason: 'Best terms',
        },
        idempotencyKey: 'idemp_commit_test_33',
      };

      const first = await commitmentService.createCommitment(input);
      const second = await commitmentService.createCommitment(input);

      expect(first.commitment.id).toBe(second.commitment.id);
      expect(commitmentService.listCommitments().length).toBe(1);
    });

    it('34. Concurrent commitment creation attempts serialize safely under in-flight guard', async () => {
      const input = {
        rfqId: rfqA.id,
        recommendation: {
          decision: 'SELECT_SUPPLIER' as const,
          supplierId: candidateA.id,
          quoteId: quoteA.id,
          reason: 'Best terms',
        },
        idempotencyKey: 'idemp_concur_test_34',
      };

      const [res1, res2, res3] = await Promise.all([
        commitmentService.createCommitment(input),
        commitmentService.createCommitment(input),
        commitmentService.createCommitment(input),
      ]);

      expect(res1.commitment.id).toBe(res2.commitment.id);
      expect(res2.commitment.id).toBe(res3.commitment.id);
      expect(commitmentService.listCommitments().length).toBe(1);
    });

    it('35. Valid commitment state transitions proceed in strict sequence', () => {
      expect(canTransitionCommitment('DRAFT', 'VALIDATED')).toBe(true);
      expect(canTransitionCommitment('VALIDATED', 'COMMITTED')).toBe(true);
      expect(canTransitionCommitment('COMMITTED', 'PURCHASE_ORDER_CREATED')).toBe(true);
      expect(canTransitionCommitment('PURCHASE_ORDER_CREATED', 'READY_FOR_PAYMENT')).toBe(true);
    });

    it('36. Illegal commitment status transitions are deterministically rejected with CommitmentStateMachineError', () => {
      expect(canTransitionCommitment('DRAFT', 'COMMITTED')).toBe(false);
      expect(canTransitionCommitment('READY_FOR_PAYMENT', 'DRAFT')).toBe(false);
      expect(canTransitionCommitment('CANCELLED', 'COMMITTED')).toBe(false);

      expect(() => assertLegalCommitmentTransition('READY_FOR_PAYMENT', 'COMMITTED')).toThrow(
        CommitmentStateMachineError
      );
    });

    it('37. Historical quote records are preserved without mutation upon commitment', async () => {
      const originalQuoteTotal = quoteA.total;
      await commitmentService.createCommitment({
        rfqId: rfqA.id,
        recommendation: {
          decision: 'SELECT_SUPPLIER',
          supplierId: candidateA.id,
          quoteId: quoteA.id,
          reason: 'Best terms',
        },
      });

      const retrievedQuote = quoteNormalizationService.getQuote(quoteA.id);
      expect(retrievedQuote!.total).toBe(originalQuoteTotal);
    });
  });

  // =========================================================================
  // 7. PURCHASE ORDER GENERATION (Tests 38 - 41)
  // =========================================================================
  describe('7. Purchase Order Generation & Multi-Supplier Dispatch', () => {
    it('38. Exactly one Purchase Order is generated for single-supplier selection', async () => {
      const { purchaseOrders } = await commitmentService.createCommitment({
        rfqId: rfqA.id,
        recommendation: {
          decision: 'SELECT_SUPPLIER',
          supplierId: candidateA.id,
          quoteId: quoteA.id,
          reason: 'Single supplier',
        },
      });

      expect(purchaseOrders.length).toBe(1);
      expect(purchaseOrders[0].supplierId).toBe(candidateA.id);
      expect(purchaseOrders[0].total).toBe(58200);
      expect(purchaseOrders[0].poNumber).toMatch(/^PO-\d{4}-[A-Z0-9]+$/);
    });

    it('39. Exactly one Purchase Order per supplier is generated for split procurement', async () => {
      // Seed quoteC and quoteD on rfqA
      rfqA.lineItems[0].quantity = 1000;
      quoteNormalizationService['quotes'].set(quoteC_partial.id, {
        ...quoteC_partial,
        rfqId: rfqA.id,
      });
      quoteNormalizationService['quotes'].set(quoteD_partial.id, {
        ...quoteD_partial,
        rfqId: rfqA.id,
      });

      const { purchaseOrders } = await commitmentService.createCommitment({
        rfqId: rfqA.id,
        recommendation: {
          decision: 'SPLIT_ORDER',
          allocations: [
            { supplierId: candidateA.id, quoteId: quoteC_partial.id, quantity: 600 },
            { supplierId: candidateB.id, quoteId: quoteD_partial.id, quantity: 400 },
          ],
          reason: 'Split order',
        },
      });

      expect(purchaseOrders.length).toBe(2);
      expect(purchaseOrders[0].supplierId).toBe(candidateA.id);
      expect(purchaseOrders[0].total).toBe(31500);

      expect(purchaseOrders[1].supplierId).toBe(candidateB.id);
      expect(purchaseOrders[1].total).toBe(21850);
    });

    it('40. Purchase order totals and quantities match commitment lines exactly', async () => {
      const { commitment, purchaseOrders } = await commitmentService.createCommitment({
        rfqId: rfqA.id,
        recommendation: {
          decision: 'SELECT_SUPPLIER',
          supplierId: candidateA.id,
          quoteId: quoteA.id,
          reason: 'PO totals check',
        },
      });

      const po = purchaseOrders[0];
      expect(po.lines[0].quantity).toBe(commitment.requestedQuantity);
      expect(po.lines[0].unitPrice).toBe(commitment.allocations[0].agreedUnitPrice);
      expect(po.total).toBe(commitment.financials.total);
    });

    it('41. Purchase order status is set to READY_FOR_PAYMENT without executing payment', async () => {
      const { purchaseOrders } = await commitmentService.createCommitment({
        rfqId: rfqA.id,
        recommendation: {
          decision: 'SELECT_SUPPLIER',
          supplierId: candidateA.id,
          quoteId: quoteA.id,
          reason: 'PO status check',
        },
      });

      expect(purchaseOrders[0].status).toBe('READY_FOR_PAYMENT');
    });
  });

  // =========================================================================
  // 8. PRIVACY & CONFIDENTIALITY INVARIANTS (Tests 42 - 45)
  // =========================================================================
  describe('8. Privacy, Confidentiality & Anti-Leakage Boundary', () => {
    it('42. Purchase order contains zero resident names or resident IDs', async () => {
      const { purchaseOrders } = await commitmentService.createCommitment({
        rfqId: rfqA.id,
        recommendation: {
          decision: 'SELECT_SUPPLIER',
          supplierId: candidateA.id,
          quoteId: quoteA.id,
          reason: 'Privacy test',
        },
      });

      const poText = purchaseOrderMessageBuilder.buildPurchaseOrderText(purchaseOrders[0]);
      expect(poText).not.toContain('resident');
      expect(poText).not.toContain('res_');
      expect(poText).not.toContain('jivhesh');
    });

    it('43. Purchase order contains zero flat or apartment unit numbers', async () => {
      const { purchaseOrders } = await commitmentService.createCommitment({
        rfqId: rfqA.id,
        recommendation: {
          decision: 'SELECT_SUPPLIER',
          supplierId: candidateA.id,
          quoteId: quoteA.id,
          reason: 'Flat number test',
        },
      });

      const poText = purchaseOrderMessageBuilder.buildPurchaseOrderText(purchaseOrders[0]);
      expect(poText).not.toContain('Flat');
      expect(poText).not.toContain('Tower A');
      expect(poText).not.toContain('A-101');
    });

    it('44. Purchase order contains zero resident budgets or payment mandates', async () => {
      const { purchaseOrders } = await commitmentService.createCommitment({
        rfqId: rfqA.id,
        recommendation: {
          decision: 'SELECT_SUPPLIER',
          supplierId: candidateA.id,
          quoteId: quoteA.id,
          reason: 'Mandate test',
        },
      });

      const poText = purchaseOrderMessageBuilder.buildPurchaseOrderText(purchaseOrders[0]);
      expect(poText).not.toContain('mandate');
      expect(poText).not.toContain('budget');
      expect(poText).not.toContain('spending limit');
    });

    it('45. In split orders, Supplier A Purchase Order contains zero competitor identity or terms', async () => {
      rfqA.lineItems[0].quantity = 1000;
      quoteNormalizationService['quotes'].set(quoteC_partial.id, {
        ...quoteC_partial,
        rfqId: rfqA.id,
      });
      quoteNormalizationService['quotes'].set(quoteD_partial.id, {
        ...quoteD_partial,
        rfqId: rfqA.id,
      });

      const { purchaseOrders } = await commitmentService.createCommitment({
        rfqId: rfqA.id,
        recommendation: {
          decision: 'SPLIT_ORDER',
          allocations: [
            { supplierId: candidateA.id, quoteId: quoteC_partial.id, quantity: 600 },
            { supplierId: candidateB.id, quoteId: quoteD_partial.id, quantity: 400 },
          ],
          reason: 'Split confidentiality',
        },
      });

      const poTextA = purchaseOrderMessageBuilder.buildPurchaseOrderText(purchaseOrders[0]);
      const poTextB = purchaseOrderMessageBuilder.buildPurchaseOrderText(purchaseOrders[1]);

      // PO A must not mention candidateB
      expect(poTextA).not.toContain(candidateB.name);
      expect(poTextA).not.toContain(candidateB.email);

      // PO B must not mention candidateA
      expect(poTextB).not.toContain(candidateA.name);
      expect(poTextB).not.toContain(candidateA.email);
    });
  });

  // =========================================================================
  // 9. AUDIT TRAIL LOGGING (Tests 46 - 50)
  // =========================================================================
  describe('9. Complete Domain Audit Trail', () => {
    it('46. QUOTE_SELECTION_STARTED event is emitted with decision type', async () => {
      const events: any[] = [];
      const sub = (e: any) => events.push(e);
      eventBus.subscribe('QUOTE_SELECTION_STARTED', sub);

      try {
        await commitmentService.createCommitment({
          rfqId: rfqA.id,
          recommendation: {
            decision: 'SELECT_SUPPLIER',
            supplierId: candidateA.id,
            quoteId: quoteA.id,
            reason: 'Audit test',
          },
        });

        expect(events.length).toBe(1);
        expect(events[0].payload.decisionType).toBe('SELECT_SUPPLIER');
      } finally {
        eventBus.unsubscribe('QUOTE_SELECTION_STARTED', sub);
      }
    });

    it('47. SELECTION_VALIDATED event is emitted upon passing deterministic checks', async () => {
      const events: any[] = [];
      const sub = (e: any) => events.push(e);
      eventBus.subscribe('SELECTION_VALIDATED', sub);

      try {
        await commitmentService.createCommitment({
          rfqId: rfqA.id,
          recommendation: {
            decision: 'SELECT_SUPPLIER',
            supplierId: candidateA.id,
            quoteId: quoteA.id,
            reason: 'Audit test',
          },
        });

        expect(events.length).toBe(1);
        expect(events[0].payload.decision).toBe('SELECT_SUPPLIER');
      } finally {
        eventBus.unsubscribe('SELECTION_VALIDATED', sub);
      }
    });

    it('48. ALLOCATION_CREATED and ALLOCATION_VALIDATED events are emitted', async () => {
      const events: any[] = [];
      const sub = (e: any) => events.push(e);
      eventBus.subscribe('ALLOCATION_CREATED', sub);
      eventBus.subscribe('ALLOCATION_VALIDATED', sub);

      try {
        await commitmentService.createCommitment({
          rfqId: rfqA.id,
          recommendation: {
            decision: 'SELECT_SUPPLIER',
            supplierId: candidateA.id,
            quoteId: quoteA.id,
            reason: 'Audit test',
          },
        });

        expect(events.some((e) => e.name === 'ALLOCATION_CREATED')).toBe(true);
        expect(events.some((e) => e.name === 'ALLOCATION_VALIDATED')).toBe(true);
      } finally {
        eventBus.unsubscribe('ALLOCATION_CREATED', sub);
        eventBus.unsubscribe('ALLOCATION_VALIDATED', sub);
      }
    });

    it('49. PROCUREMENT_COMMITMENT_CREATED and PROCUREMENT_COMMITTED are emitted', async () => {
      const events: any[] = [];
      const sub = (e: any) => events.push(e);
      eventBus.subscribe('PROCUREMENT_COMMITMENT_CREATED', sub);
      eventBus.subscribe('PROCUREMENT_COMMITTED', sub);

      try {
        await commitmentService.createCommitment({
          rfqId: rfqA.id,
          recommendation: {
            decision: 'SELECT_SUPPLIER',
            supplierId: candidateA.id,
            quoteId: quoteA.id,
            reason: 'Audit test',
          },
        });

        expect(events.some((e) => e.name === 'PROCUREMENT_COMMITMENT_CREATED')).toBe(true);
        expect(events.some((e) => e.name === 'PROCUREMENT_COMMITTED')).toBe(true);
      } finally {
        eventBus.unsubscribe('PROCUREMENT_COMMITMENT_CREATED', sub);
        eventBus.unsubscribe('PROCUREMENT_COMMITTED', sub);
      }
    });

    it('50. PURCHASE_ORDER_CREATED and PROCUREMENT_READY_FOR_PAYMENT are emitted', async () => {
      const events: any[] = [];
      const sub = (e: any) => events.push(e);
      eventBus.subscribe('PURCHASE_ORDER_CREATED', sub);
      eventBus.subscribe('PROCUREMENT_READY_FOR_PAYMENT', sub);

      try {
        await commitmentService.createCommitment({
          rfqId: rfqA.id,
          recommendation: {
            decision: 'SELECT_SUPPLIER',
            supplierId: candidateA.id,
            quoteId: quoteA.id,
            reason: 'Audit test',
          },
        });

        expect(events.some((e) => e.name === 'PURCHASE_ORDER_CREATED')).toBe(true);
        expect(events.some((e) => e.name === 'PROCUREMENT_READY_FOR_PAYMENT')).toBe(true);
      } finally {
        eventBus.unsubscribe('PURCHASE_ORDER_CREATED', sub);
        eventBus.unsubscribe('PROCUREMENT_READY_FOR_PAYMENT', sub);
      }
    });
  });

  // =========================================================================
  // 10. CONSTRAINED AGENT TOOLS & FINANCIAL BOUNDARIES (Tests 51 - 55)
  // =========================================================================
  describe('10. Constrained Agent Tools & Financial Safeguards', () => {
    it('51. Tool registry contains zero payment or order commitment tools in selection', () => {
      const toolNames = toolRegistry.list().map((t) => t.name);

      expect(toolNames).toContain('compareQuotesForSelection');
      expect(toolNames).toContain('getSelectionState');
      expect(toolNames).toContain('recommendSupplierSelection');
      expect(toolNames).toContain('validateSelection');
      expect(toolNames).toContain('getProcurementCommitment');
      expect(toolNames).toContain('getPurchaseOrder');

      // Crucial: No payment or money-moving tools exist in selection phase
      expect(toolNames).not.toContain('executeSupplierPayment');
      expect(toolNames).not.toContain('directBankTransfer');
      expect(toolNames).not.toContain('chargeResidentCard');
    });

    it('52. compareQuotesForSelection tool executes through registry and returns factual metrics', async () => {
      const defaultCandidate = { ...candidateA, id: 'cand_tool_52' };
      const rfq = await defaultRfqService.createRFQ({
        candidate: defaultCandidate,
        lineItems: [{ productName: 'Wheat', quantity: 1000, unit: 'KG' }],
        deliveryArea: 'Baner, Pune',
        deliveryDeadline: new Date(Date.now() + 86400000),
        quoteDeadline: new Date(Date.now() + 43200000),
      });

      const respService = new SupplierResponseService(defaultRfqService);
      const resp = await respService.ingestResponse({
        rfqId: rfq.id,
        candidateId: defaultCandidate.id,
        supplierName: defaultCandidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat', unitPrice: 50, quotedQuantity: 1000, unit: 'KG' }],
        deliveryFee: 100,
        deliveryEtaHours: 8,
        validUntil: new Date(Date.now() + 43200000),
      });
      await defaultQuoteService.normalizeResponse(resp);

      const tool = toolRegistry.get('compareQuotesForSelection')!;
      const result: any = await tool.execute({ rfqId: rfq.id });

      expect(result.success).toBe(true);
      expect(result.comparison.quotes.length).toBe(1);
      expect(result.comparison.lowestCostQuoteId).toBeDefined();
    });

    it('53. getSelectionState tool retrieves active commitment and purchase orders', async () => {
      const defaultCandidate = { ...candidateA, id: 'cand_tool_53' };
      const rfq = await defaultRfqService.createRFQ({
        candidate: defaultCandidate,
        lineItems: [{ productName: 'Wheat', quantity: 1000, unit: 'KG' }],
        deliveryArea: 'Baner, Pune',
        deliveryDeadline: new Date(Date.now() + 86400000),
        quoteDeadline: new Date(Date.now() + 43200000),
      });

      const respService = new SupplierResponseService(defaultRfqService);
      const resp = await respService.ingestResponse({
        rfqId: rfq.id,
        candidateId: defaultCandidate.id,
        supplierName: defaultCandidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat', unitPrice: 50, quotedQuantity: 1000, unit: 'KG' }],
        deliveryFee: 100,
        deliveryEtaHours: 8,
        validUntil: new Date(Date.now() + 43200000),
      });
      const { quote } = await defaultQuoteService.normalizeResponse(resp);

      await defaultCommitmentService.createCommitment({
        rfqId: rfq.id,
        recommendation: {
          decision: 'SELECT_SUPPLIER',
          supplierId: defaultCandidate.id,
          quoteId: quote.id,
          reason: 'Tool state test',
        },
      });

      const tool = toolRegistry.get('getSelectionState')!;
      const result: any = await tool.execute({ rfqId: rfq.id });

      expect(result.success).toBe(true);
      expect(result.hasCommitment).toBe(true);
      expect(result.commitment.status).toBe('READY_FOR_PAYMENT');
      expect(result.purchaseOrders.length).toBe(1);
    });

    it('54. recommendSupplierSelection tool executes autonomous selection end-to-end', async () => {
      const defaultCandidate = { ...candidateA, id: 'cand_tool_54' };
      const rfq = await defaultRfqService.createRFQ({
        candidate: defaultCandidate,
        lineItems: [{ productName: 'Wheat', quantity: 1000, unit: 'KG' }],
        deliveryArea: 'Baner, Pune',
        deliveryDeadline: new Date(Date.now() + 86400000),
        quoteDeadline: new Date(Date.now() + 43200000),
      });

      const respService = new SupplierResponseService(defaultRfqService);
      const resp = await respService.ingestResponse({
        rfqId: rfq.id,
        candidateId: defaultCandidate.id,
        supplierName: defaultCandidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat', unitPrice: 50, quotedQuantity: 1000, unit: 'KG' }],
        deliveryFee: 100,
        deliveryEtaHours: 8,
        validUntil: new Date(Date.now() + 43200000),
      });
      await defaultQuoteService.normalizeResponse(resp);

      const tool = toolRegistry.get('recommendSupplierSelection')!;
      const result: any = await tool.execute({ rfqId: rfq.id });

      expect(result.success).toBe(true);
      expect(result.decision).toBe('SELECT_SUPPLIER');
      expect(result.hasCommitment).toBe(true);
      expect(result.status).toBe('READY_FOR_PAYMENT');
    });

    it('55. validateSelection tool correctly rejects invalid proposed allocation', async () => {
      const defaultCandidate = { ...candidateA, id: 'cand_tool_55' };
      const rfq = await defaultRfqService.createRFQ({
        candidate: defaultCandidate,
        lineItems: [{ productName: 'Wheat', quantity: 1000, unit: 'KG' }],
        deliveryArea: 'Baner, Pune',
        deliveryDeadline: new Date(Date.now() + 86400000),
        quoteDeadline: new Date(Date.now() + 43200000),
      });

      const tool = toolRegistry.get('validateSelection')!;
      const result: any = await tool.execute({
        rfqId: rfq.id,
        decision: 'SELECT_SUPPLIER',
        supplierId: 'cand_nonexistent',
        quoteId: 'quote_nonexistent',
        reason: 'Should fail validation',
      });

      expect(result.success).toBe(true);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
