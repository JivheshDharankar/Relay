import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  QuoteNormalizationService,
  quoteNormalizationService as defaultNormalizationService,
  SupplierResponseService,
  supplierResponseService as defaultResponseService,
  MockSupplierResponseProvider,
  EmailSupplierResponseProvider,
  SupplierResponseError,
  QuoteStateMachineError,
  canTransitionQuote,
  assertLegalQuoteTransition,
  RFQService,
  rfqService as defaultRfqService,
  SupplierCandidate,
  IngestResponseInput,
} from '../src/discovery/supplier';
import { toolRegistry } from '../src/agent/tools';
import { eventBus } from '../src/events';

function createMockCandidate(overrides: Partial<SupplierCandidate> = {}): SupplierCandidate {
  return {
    id: 'cand_pune_wholesaler_01',
    name: 'Deccan Grain & Oil Wholesalers',
    formattedAddress: 'Market Yard Gate 4, Pune',
    latitude: 18.5204,
    longitude: 73.8567,
    distanceKm: 3.5,
    distanceMeters: 3500,
    categories: ['commercial.wholesale'],
    source: 'geoapify',
    email: 'quotes@deccangrain.example.com',
    phone: '+91 20 24445566',
    ...overrides,
  };
}

describe('Milestone 10 Phase 4 — Supplier Response Ingestion & Quote Normalization', () => {
  let rfqService: RFQService;
  let responseService: SupplierResponseService;
  let normalizationService: QuoteNormalizationService;

  beforeEach(() => {
    vi.restoreAllMocks();
    rfqService = new RFQService();
    responseService = new SupplierResponseService(rfqService);
    normalizationService = new QuoteNormalizationService();
  });

  async function setupActiveRFQ(candidateOverrides: Partial<SupplierCandidate> = {}) {
    const candidate = createMockCandidate(candidateOverrides);
    const now = new Date();
    const rfq = await rfqService.createRFQ(
      {
        candidate,
        lineItems: [
          { productName: 'Sharbati Whole Wheat Atta', quantity: 20, unit: 'KG' },
          { productName: 'Cold-Pressed Sunflower Oil', quantity: 10, unit: 'LITRE' },
        ],
        deliveryArea: 'Greenview Residency Community Service Area, Pune',
        quoteDeadline: new Date(now.getTime() + 2 * 3600 * 1000),
        deliveryDeadline: new Date(now.getTime() + 12 * 3600 * 1000),
      },
      undefined,
      now
    );
    return { rfq, candidate };
  }

  describe('1. Response Ingestion & Relationship Validation', () => {
    it('1. valid supplier response is ingested successfully', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [
          { productName: 'Sharbati Whole Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 },
          { productName: 'Cold-Pressed Sunflower Oil', quotedQuantity: 10, unit: 'LITRE', unitPrice: 165 },
        ],
        deliveryFee: 50,
        tax: 0,
        deliveryEtaHours: 6,
      });

      expect(response.id).toMatch(/^resp_/);
      expect(response.status).toBe('RECEIVED');
      expect(response.lineItems).toHaveLength(2);
      expect(response.rfq.id).toBe(rfq.id);
    });

    it('2. response for unknown RFQ is rejected with RFQ_NOT_FOUND', async () => {
      await expect(
        responseService.ingestResponse({
          rfqId: 'rfq_non_existent_999',
          candidateId: 'cand_1',
          supplierName: 'Some Supplier',
          channel: 'manual',
          lineItems: [],
        })
      ).rejects.toMatchObject({
        name: 'SupplierResponseError',
        code: 'RFQ_NOT_FOUND',
      });
    });

    it('3. response from wrong supplier candidate is rejected with SUPPLIER_MISMATCH', async () => {
      const { rfq } = await setupActiveRFQ();

      await expect(
        responseService.ingestResponse({
          rfqId: rfq.id,
          candidateId: 'cand_different_intruder_99',
          supplierName: 'Intruder Corp',
          channel: 'manual',
          lineItems: [],
        })
      ).rejects.toMatchObject({
        name: 'SupplierResponseError',
        code: 'SUPPLIER_MISMATCH',
      });
    });

    it('4. response for cancelled RFQ is rejected with RFQ_INACTIVE', async () => {
      const { rfq, candidate } = await setupActiveRFQ();
      rfqService.cancelRFQ(rfq.id, 'Procurement cancelled by community');

      await expect(
        responseService.ingestResponse({
          rfqId: rfq.id,
          candidateId: candidate.id,
          supplierName: candidate.name,
          channel: 'manual',
          lineItems: [],
        })
      ).rejects.toMatchObject({
        name: 'SupplierResponseError',
        code: 'RFQ_INACTIVE',
      });
    });

    it('5. duplicate response ingestion with same idempotency key is idempotent', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const input: IngestResponseInput = {
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        idempotencyKey: 'fixed_idemp_key_resp_1',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
      };

      const resp1 = await responseService.ingestResponse(input);
      const resp2 = await responseService.ingestResponse(input);

      expect(resp1.id).toBe(resp2.id);
      expect(responseService.listResponses()).toHaveLength(1);
    });

    it('6. concurrent duplicate ingestions remain safe and resolve to the same response', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const input: IngestResponseInput = {
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        idempotencyKey: 'concurrent_idemp_resp_2',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
      };

      const [resp1, resp2] = await Promise.all([
        responseService.ingestResponse(input),
        responseService.ingestResponse(input),
      ]);

      expect(resp1.id).toBe(resp2.id);
      expect(responseService.listResponses()).toHaveLength(1);
    });
  });

  describe('2. Deterministic Quote Normalization & Decimal Arithmetic', () => {
    it('7. valid response normalizes into a trusted Quote entity with VALID status', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [
          { productName: 'Sharbati Whole Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 },
          { productName: 'Cold-Pressed Sunflower Oil', quotedQuantity: 10, unit: 'LITRE', unitPrice: 165 },
        ],
        deliveryFee: 50,
        tax: 25,
        deliveryEtaHours: 6,
      });

      const result = await normalizationService.normalizeResponse(response);

      expect(result.quote.id).toMatch(/^quote_/);
      expect(result.quote.status).toBe('VALID');
      expect(result.quote.reasons).toContain('QUOTE_VALID');
      expect(result.quote.rejectionReasons).toHaveLength(0);
      expect(result.quote.supplierName).toBe(candidate.name);
    });

    it('8. money calculation uses Decimal arithmetic and prevents JS floating-point errors', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      // In floating-point: 0.1 * 3 = 0.30000000000000004
      // Decimal must yield exact 0.30
      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [
          { productName: 'Sharbati Whole Wheat Atta', quotedQuantity: 3, unit: 'KG', unitPrice: 0.1 },
        ],
        deliveryFee: 0.2, // 0.3 + 0.2 in float is 0.5000000000000001
      });

      const { quote } = await normalizationService.normalizeResponse(response);

      expect(quote.lineItems[0].lineSubtotal).toBe(0.3);
      expect(quote.subtotal).toBe(0.3);
      expect(quote.total).toBe(0.5);
    });

    it('9. line subtotal is calculated deterministically as quotedQuantity × unitPrice', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [
          { productName: 'Sharbati Whole Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 },
        ],
      });

      const { quote } = await normalizationService.normalizeResponse(response);

      expect(quote.lineItems[0].lineSubtotal).toBe(900); // 20 * 45
    });

    it('10. subtotal is calculated correctly as sum of line subtotals', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [
          { productName: 'Sharbati Whole Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }, // 900
          { productName: 'Cold-Pressed Sunflower Oil', quotedQuantity: 10, unit: 'LITRE', unitPrice: 165 }, // 1650
        ],
      });

      const { quote } = await normalizationService.normalizeResponse(response);

      expect(quote.subtotal).toBe(2550); // 900 + 1650
    });

    it('11. delivery fee is included in final total', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 10, unit: 'KG', unitPrice: 40 }], // 400
        deliveryFee: 75,
      });

      const { quote } = await normalizationService.normalizeResponse(response);

      expect(quote.deliveryFee).toBe(75);
      expect(quote.total).toBe(475); // 400 + 75
    });

    it('12. tax is included in final total', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 10, unit: 'KG', unitPrice: 40 }], // 400
        tax: 20,
      });

      const { quote } = await normalizationService.normalizeResponse(response);

      expect(quote.tax).toBe(20);
      expect(quote.total).toBe(420); // 400 + 20
    });

    it('13. other charges are included in final total', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 10, unit: 'KG', unitPrice: 40 }], // 400
        otherCharges: 15,
      });

      const { quote } = await normalizationService.normalizeResponse(response);

      expect(quote.otherCharges).toBe(15);
      expect(quote.total).toBe(415); // 400 + 15
    });

    it('14. final total is calculated deterministically as subtotal + deliveryFee + tax + otherCharges', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [
          { productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }, // 900
          { productName: 'Sunflower Oil', quotedQuantity: 5, unit: 'LITRE', unitPrice: 160 }, // 800
        ],
        deliveryFee: 50,
        tax: 85,
        otherCharges: 25,
      });

      const { quote } = await normalizationService.normalizeResponse(response);

      expect(quote.subtotal).toBe(1700);
      expect(quote.total).toBe(1860); // 1700 + 50 + 85 + 25
    });

    it('15. supplier-provided total mismatch is detected and flagged explicitly with QUOTE_TOTAL_MISMATCH', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 10, unit: 'KG', unitPrice: 40 }], // 400
        deliveryFee: 50, // Calculated total = 450
        supplierProvidedTotal: 500, // Supplier claims 500 (₹50 discrepancy!)
      });

      const { quote } = await normalizationService.normalizeResponse(response);

      expect(quote.hasTotalMismatch).toBe(true);
      expect(quote.total).toBe(450); // Calculated
      expect(quote.supplierProvidedTotal).toBe(500);
      expect(quote.totalMismatchDifference).toBe(50);
      expect(quote.reasons).toContain('QUOTE_TOTAL_MISMATCH');
      expect(quote.status).toBe('INVALID'); // Discrepancy invalidates automatic acceptance
    });

    it('16. invalid quantity (zero or negative) is rejected with INVALID_QUANTITY', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 0, unit: 'KG', unitPrice: 40 }],
      });

      const { quote } = await normalizationService.normalizeResponse(response);

      expect(quote.status).toBe('INVALID');
      expect(quote.rejectionReasons).toContain('INVALID_QUANTITY');
    });

    it('17. partial quantity is represented correctly with status PARTIAL (preserves both 12 and 20)', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      // RFQ requested 20 KG wheat; supplier offers only 12 KG
      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Sharbati Whole Wheat Atta', quotedQuantity: 12, unit: 'KG', unitPrice: 45 }],
      });

      const { quote } = await normalizationService.normalizeResponse(response);

      expect(quote.status).toBe('PARTIAL');
      expect(quote.reasons).toContain('PARTIAL_QUANTITY_OFFERED');

      const [item] = quote.lineItems;
      expect(item.quotedQuantity).toBe(12);
      expect(item.requestedQuantity).toBe(20);
      expect(item.isPartial).toBe(true);
      // Math is based on offered 12 kg, not 20 kg
      expect(item.lineSubtotal).toBe(540); // 12 * 45
    });

    it('18. invalid or mismatching unit is rejected with INVALID_UNIT', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      // RFQ requested in KG, supplier responds in LITRE
      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Sharbati Whole Wheat Atta', quotedQuantity: 20, unit: 'LITRE', unitPrice: 45 }],
      });

      const { quote } = await normalizationService.normalizeResponse(response);

      expect(quote.status).toBe('INVALID');
      expect(quote.rejectionReasons).toContain('INVALID_UNIT');
    });

    it('19. missing delivery information is represented explicitly as DELIVERY_TIME_UNKNOWN', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      // No deliveryEtaHours or confirmedDeliveryEta supplied
      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
      });

      const { quote } = await normalizationService.normalizeResponse(response);

      expect(quote.deliveryCommitment).toBe('UNKNOWN');
      expect(quote.reasons).toContain('DELIVERY_TIME_UNKNOWN');
    });

    it('20. delivery deadline violations are detected with DELIVERY_DEADLINE_EXCEEDED', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      // RFQ deadline is 12h; supplier commits to 24h turnaround
      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
        deliveryEtaHours: 24, // Exceeds 12h!
      });

      const { quote } = await normalizationService.normalizeResponse(response);

      expect(quote.deliveryCommitment).toBe('EXCEEDED');
      expect(quote.rejectionReasons).toContain('DELIVERY_DEADLINE_EXCEEDED');
      expect(quote.status).toBe('INVALID');
    });

    it('21. quote validity is validated against received timestamp', async () => {
      const { rfq, candidate } = await setupActiveRFQ();
      const now = new Date();

      // validUntil is in the past relative to receivedAt
      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
        receivedAt: now,
        validUntil: new Date(now.getTime() - 3600 * 1000), // 1h before received!
      });

      const { quote } = await normalizationService.normalizeResponse(response, now);

      expect(quote.rejectionReasons).toContain('QUOTE_EXPIRED');
      expect(quote.status).toBe('EXPIRED');
    });

    it('22. expired quote cannot become active', async () => {
      const { rfq, candidate } = await setupActiveRFQ();
      const receivedAt = new Date('2026-10-30T10:00:00Z');
      const validUntil = new Date('2026-10-30T12:00:00Z'); // Expired at 12:00

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
        receivedAt,
        validUntil,
      });

      // Evaluated at 14:00 (after validUntil)
      const evaluationTime = new Date('2026-10-30T14:00:00Z');
      const { quote } = await normalizationService.normalizeResponse(response, evaluationTime);

      expect(quote.status).toBe('EXPIRED');
    });
  });

  describe('3. Quote State Machine', () => {
    it('23. valid quote transitions succeed deterministically', () => {
      expect(canTransitionQuote('RECEIVED', 'VALIDATING')).toBe(true);
      expect(canTransitionQuote('VALIDATING', 'VALID')).toBe(true);
      expect(canTransitionQuote('VALIDATING', 'PARTIAL')).toBe(true);
      expect(canTransitionQuote('VALIDATING', 'INVALID')).toBe(true);
      expect(canTransitionQuote('VALID', 'EXPIRED')).toBe(true);
      expect(canTransitionQuote('VALID', 'SUPERSEDED')).toBe(true);

      expect(() => assertLegalQuoteTransition('VALIDATING', 'VALID')).not.toThrow();
    });

    it('24. invalid quote transitions fail with QuoteStateMachineError', () => {
      expect(canTransitionQuote('INVALID', 'VALID')).toBe(false);
      expect(canTransitionQuote('EXPIRED', 'VALID')).toBe(false);
      expect(canTransitionQuote('SUPERSEDED', 'VALID')).toBe(false);

      expect(() => assertLegalQuoteTransition('INVALID', 'VALID')).toThrow(QuoteStateMachineError);
      expect(() => assertLegalQuoteTransition('EXPIRED', 'VALIDATING')).toThrow(QuoteStateMachineError);
    });

    it('25. partial quote remains distinguishable from fully valid quote', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const responseFull = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Sharbati Whole Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
      });

      const responsePartial = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        idempotencyKey: 'partial_resp_key',
        lineItems: [{ productName: 'Sharbati Whole Wheat Atta', quotedQuantity: 10, unit: 'KG', unitPrice: 45 }],
      });

      const { quote: quoteFull } = await normalizationService.normalizeResponse(responseFull);
      const { quote: quotePartial } = await normalizationService.normalizeResponse(responsePartial);

      expect(quoteFull.status).toBe('VALID');
      expect(quotePartial.status).toBe('PARTIAL');
      expect(quoteFull.status).not.toBe(quotePartial.status);
    });

    it('26. invalid quote cannot become selectable for procurement', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: -1, unit: 'KG', unitPrice: 40 }],
      });

      const { quote } = await normalizationService.normalizeResponse(response);

      expect(quote.status).toBe('INVALID');
      // Terminal state check
      expect(canTransitionQuote(quote.status, 'VALID')).toBe(false);
    });

    it('27. expired quote cannot be selected for procurement', async () => {
      const { rfq, candidate } = await setupActiveRFQ();
      const past = new Date(Date.now() - 3600 * 1000);

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
        validUntil: past,
      });

      const { quote } = await normalizationService.normalizeResponse(response);

      expect(quote.status).toBe('EXPIRED');
      expect(canTransitionQuote(quote.status, 'VALID')).toBe(false);
    });
  });

  describe('4. Privacy & Resident Anonymization', () => {
    it('28. resident personal information is not propagated into quote domain', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
      });

      const { quote } = await normalizationService.normalizeResponse(response);
      const serialized = JSON.stringify(quote);

      expect(serialized).not.toContain('Aarav');
      expect(serialized).not.toContain('Flat');
      expect(serialized).not.toContain('Tower');
    });

    it('29. private budget information is not leaked into supplier quote', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
      });

      const { quote } = await normalizationService.normalizeResponse(response);
      const serialized = JSON.stringify(quote);

      expect(serialized).not.toContain('budget');
      expect(serialized).not.toContain('maxSpend');
    });

    it('30. payment mandate information is not propagated', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
      });

      const { quote } = await normalizationService.normalizeResponse(response);
      const serialized = JSON.stringify(quote);

      expect(serialized).not.toContain('mandate');
      expect(serialized).not.toContain('upi');
      expect(serialized).not.toContain('card');
    });
  });

  describe('5. Provider Abstraction & Interchangeability', () => {
    it('31. response providers (manual, email) implement the same SupplierResponseProvider interface', () => {
      const manualProvider = new MockSupplierResponseProvider();
      const emailProvider = new EmailSupplierResponseProvider();

      expect(typeof manualProvider.ingest).toBe('function');
      expect(typeof emailProvider.ingest).toBe('function');
      expect(manualProvider.channel).toBe('manual');
      expect(emailProvider.channel).toBe('email');
    });

    it('32. mock provider operates purely in-memory with zero network calls', async () => {
      const { rfq, candidate } = await setupActiveRFQ();
      const manualProvider = new MockSupplierResponseProvider(rfqService);

      const resp = await manualProvider.ingest({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Rice', quotedQuantity: 10, unit: 'KG', unitPrice: 50 }],
      });

      expect(resp.status).toBe('RECEIVED');
      expect(resp.lineItems).toHaveLength(1);
    });

    it('33. normalization service is decoupled from transport channel', async () => {
      const { rfq, candidate } = await setupActiveRFQ();

      // Normalization functions identically whether response came via email, manual, or api
      for (const channel of ['email', 'manual', 'api'] as const) {
        const response = await responseService.ingestResponse({
          rfqId: rfq.id,
          candidateId: candidate.id,
          supplierName: candidate.name,
          channel,
          idempotencyKey: `idemp_${channel}`,
          lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
        });

        const { quote } = await normalizationService.normalizeResponse(response);
        expect(quote.status).toBe('VALID');
        expect(quote.channel).toBe(channel);
      }
    });
  });

  describe('6. Audit Events', () => {
    it('34. response ingestion emits SUPPLIER_RESPONSE_RECEIVED event', async () => {
      const { rfq, candidate } = await setupActiveRFQ();
      const published: string[] = [];

      eventBus.subscribe('SUPPLIER_RESPONSE_RECEIVED', (evt) => {
        published.push(evt.name);
      });

      await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
      });

      expect(published).toContain('SUPPLIER_RESPONSE_RECEIVED');
    });

    it('35. quote creation emits QUOTE_CREATED and QUOTE_VALID events', async () => {
      const { rfq, candidate } = await setupActiveRFQ();
      const published: string[] = [];

      eventBus.subscribe('QUOTE_CREATED', (evt) => published.push(evt.name));
      eventBus.subscribe('QUOTE_VALID', (evt) => published.push(evt.name));

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
      });

      await normalizationService.normalizeResponse(response);

      expect(published).toContain('QUOTE_CREATED');
      expect(published).toContain('QUOTE_VALID');
    });

    it('36. invalid quote emits QUOTE_INVALID event', async () => {
      const { rfq, candidate } = await setupActiveRFQ();
      const published: string[] = [];

      eventBus.subscribe('QUOTE_INVALID', (evt) => published.push(evt.name));

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: -5, unit: 'KG', unitPrice: 45 }],
      });

      await normalizationService.normalizeResponse(response);

      expect(published).toContain('QUOTE_INVALID');
    });

    it('37. total mismatch emits QUOTE_TOTAL_MISMATCH event', async () => {
      const { rfq, candidate } = await setupActiveRFQ();
      const published: string[] = [];

      eventBus.subscribe('QUOTE_TOTAL_MISMATCH', (evt) => published.push(evt.name));

      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 10, unit: 'KG', unitPrice: 40 }], // 400
        supplierProvidedTotal: 999, // Mismatch!
      });

      await normalizationService.normalizeResponse(response);

      expect(published).toContain('QUOTE_TOTAL_MISMATCH');
    });
  });

  describe('7. Constrained AI Agent Tools', () => {
    it('38. getQuotesForRFQTool retrieves normalized quotes for an RFQ through tool registry', async () => {
      expect(toolRegistry.has('getQuotesForRFQ')).toBe(true);

      const candidate = createMockCandidate({ id: 'cand_tool_test_38' });
      const now = new Date();
      const rfq = await defaultRfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Wheat Atta', quantity: 20, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Community Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
        },
        undefined,
        now
      );

      const response = await defaultResponseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
      });

      await defaultNormalizationService.normalizeResponse(response);

      const res = await toolRegistry.execute(
        'getQuotesForRFQ',
        { rfqId: rfq.id },
        { residentId: 'res1', societyId: 'soc1' }
      );

      expect(res.success).toBe(true);
      expect(res.rfqId).toBe(rfq.id);
      expect(res.quoteCount).toBeGreaterThanOrEqual(1);
      expect(res.quotes[0].total).toBe(900);
    });

    it('39. getQuoteTool retrieves specific quote details by ID through tool registry', async () => {
      expect(toolRegistry.has('getQuote')).toBe(true);

      const candidate = createMockCandidate({ id: 'cand_tool_test_39' });
      const now = new Date();
      const rfq = await defaultRfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Wheat Atta', quantity: 20, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Community Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
        },
        undefined,
        now
      );

      const response = await defaultResponseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Wheat Atta', quotedQuantity: 20, unit: 'KG', unitPrice: 45 }],
      });

      const { quote } = await defaultNormalizationService.normalizeResponse(response);

      const res = await toolRegistry.execute(
        'getQuote',
        { quoteId: quote.id },
        { residentId: 'res1', societyId: 'soc1' }
      );

      expect(res.success).toBe(true);
      expect(res.quote.id).toBe(quote.id);
      expect(res.quote.total).toBe(900);
      expect(res.quote.supplierName).toBe(candidate.name);
    });
  });
});
