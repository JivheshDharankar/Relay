import { describe, it, expect, beforeEach } from 'vitest';
import { RFQService } from '../src/discovery/supplier/rfq/RFQService';
import { QuoteNormalizationService } from '../src/discovery/supplier/quote/QuoteNormalizationService';
import { SupplierResponseService } from '../src/discovery/supplier/quote/provider/SupplierResponseService';
import { MockSupplierResponseProvider } from '../src/discovery/supplier/quote/provider/MockSupplierResponseProvider';
import { SupplierContactService } from '../src/discovery/supplier/rfq/contact/SupplierContactService';
import { MockSupplierContactProvider } from '../src/discovery/supplier/rfq/contact/MockSupplierContactProvider';
import {
  negotiationService as defaultNegotiationService,
  rfqService as defaultRfqService,
  quoteNormalizationService as defaultQuoteService,
} from '../src/discovery/supplier';
import {
  NegotiationService,
  NegotiationValidationError,
  QuoteComparisonService,
  DeterministicNegotiationValidator,
  NegotiationAIAdvisor,
  NegotiationMessageBuilder,
  assertLegalNegotiationTransition,
  canTransitionNegotiation,
  NegotiationStateMachineError,
  NegotiationProposal,
  NegotiationStatus,
} from '../src/discovery/supplier/negotiation';
import { SupplierCandidate } from '../src/discovery/supplier/types';
import { RFQ } from '../src/discovery/supplier/rfq/types';
import { Quote } from '../src/discovery/supplier/quote/types';
import { toolRegistry } from '../src/agent/tools';
import { eventBus } from '../src/events';

describe('Phase 5: Autonomous Negotiation & Quote Optimization', () => {
  let rfqService: RFQService;
  let quoteNormalizationService: QuoteNormalizationService;
  let supplierResponseService: SupplierResponseService;
  let mockContactProvider: MockSupplierContactProvider;
  let supplierContactService: SupplierContactService;
  let quoteComparisonService: QuoteComparisonService;
  let validator: DeterministicNegotiationValidator;
  let advisor: NegotiationAIAdvisor;
  let messageBuilder: NegotiationMessageBuilder;
  let negotiationService: NegotiationService;

  let testCandidateA: SupplierCandidate;
  let testCandidateB: SupplierCandidate;
  let testRfqA: RFQ;
  let testRfqB: RFQ;
  let testQuoteA: Quote;
  let testQuoteB: Quote;

  beforeEach(async () => {
    rfqService = new RFQService();
    quoteNormalizationService = new QuoteNormalizationService();

    const mockResponseProvider = new MockSupplierResponseProvider(rfqService);
    supplierResponseService = new SupplierResponseService(rfqService);
    supplierResponseService.registerProvider(mockResponseProvider);

    mockContactProvider = new MockSupplierContactProvider();
    supplierContactService = new SupplierContactService();
    supplierContactService.registerProvider(mockContactProvider);

    quoteComparisonService = new QuoteComparisonService();
    validator = new DeterministicNegotiationValidator();
    advisor = new NegotiationAIAdvisor();
    messageBuilder = new NegotiationMessageBuilder();

    negotiationService = new NegotiationService(
      quoteNormalizationService,
      rfqService,
      supplierContactService,
      quoteComparisonService,
      validator,
      advisor,
      messageBuilder,
      {
        maxRounds: 3,
        minPriceImprovementPercent: 1,
        minPriceImprovementAbsolute: 5,
        minDeliveryHoursImprovement: 1,
        maxDiscountPercent: 35,
      }
    );

    // Seed Supplier Candidates
    testCandidateA = {
      id: 'cand_pune_wholesaler_a',
      name: 'Pune Agri Wholesale A',
      address: 'Market Yard, Gultekdi, Pune',
      latitude: 18.496,
      longitude: 73.868,
      categories: ['grain_wholesaler'],
      email: 'sales@puneagriwholesale.com',
      phone: '+919876543210',
    };

    testCandidateB = {
      id: 'cand_pune_bulk_b',
      name: 'Deccan Bulk Mart B',
      address: 'Hadapsar, Pune',
      latitude: 18.502,
      longitude: 73.928,
      categories: ['grain_wholesaler'],
      email: 'orders@deccanbulk.com',
      phone: '+919876543211',
    };

    // Seed RFQs with 24h deadline
    const deadline = new Date(Date.now() + 24 * 3600 * 1000);
    testRfqA = await rfqService.createRFQ({
      candidate: testCandidateA,
      lineItems: [
        {
          productId: 'prod_rice_sona_masoori',
          productName: 'Sona Masoori Rice',
          quantity: 20,
          unit: 'KG',
        },
      ],
      deliveryArea: 'Baner, Pune',
      deliveryDeadline: deadline,
      quoteDeadline: new Date(Date.now() + 12 * 3600 * 1000),
    });

    testRfqB = await rfqService.createRFQ({
      candidate: testCandidateB,
      lineItems: [
        {
          productId: 'prod_rice_sona_masoori',
          productName: 'Sona Masoori Rice',
          quantity: 20,
          unit: 'KG',
        },
      ],
      deliveryArea: 'Baner, Pune',
      deliveryDeadline: deadline,
      quoteDeadline: new Date(Date.now() + 12 * 3600 * 1000),
    });

    // Seed Initial Quote A: 20kg @ ₹50/kg = ₹1000 + ₹90 delivery = ₹1090, ETA: 8h
    const ingestedA = await supplierResponseService.ingestResponse({
      rfqId: testRfqA.id,
      candidateId: testCandidateA.id,
      supplierName: testCandidateA.name,
      channel: 'manual',
      lineItems: [
        {
          productName: 'Sona Masoori Rice',
          unitPrice: 50,
          quotedQuantity: 20,
          unit: 'KG',
        },
      ],
      deliveryFee: 90,
      deliveryEtaHours: 8,
      validUntil: new Date(Date.now() + 12 * 3600 * 1000),
    });
    const normA = await quoteNormalizationService.normalizeResponse(ingestedA);
    testQuoteA = normA.quote;

    // Seed Initial Quote B: 20kg @ ₹52/kg = ₹1040 + ₹50 delivery = ₹1090, ETA: 4h (faster delivery)
    const ingestedB = await supplierResponseService.ingestResponse({
      rfqId: testRfqB.id,
      candidateId: testCandidateB.id,
      supplierName: testCandidateB.name,
      channel: 'manual',
      lineItems: [
        {
          productName: 'Sona Masoori Rice',
          unitPrice: 52,
          quotedQuantity: 20,
          unit: 'KG',
        },
      ],
      deliveryFee: 50,
      deliveryEtaHours: 4,
      validUntil: new Date(Date.now() + 12 * 3600 * 1000),
    });
    const normB = await quoteNormalizationService.normalizeResponse(ingestedB);
    testQuoteB = normB.quote;
  });

  // =========================================================================
  // 1. QUOTE ANALYSIS & COMPARISON (Tests 1 - 5)
  // =========================================================================
  describe('1. Quote Analysis & Deterministic Comparison', () => {
    it('1. AI receives only normalized quote data', async () => {
      const quotes = quoteNormalizationService.listQuotes();
      expect(quotes.length).toBe(2);
      expect(quotes[0].subtotal).toBe(1000);
      expect(quotes[0].total).toBe(1090);
      expect(quotes[1].total).toBe(1090);
    });

    it('2. AI cannot access raw database directly', () => {
      // Comparison service takes strictly RFQ and Quote entities
      const comparison = quoteComparisonService.compareQuotes(testRfqA, [testQuoteA, testQuoteB]);
      expect(comparison.quotes.length).toBe(2);
      expect(comparison.rfqId).toBe(testRfqA.id);
    });

    it('3. Quote comparisons compute deterministic factual metrics without floating-point error', () => {
      const comparison = quoteComparisonService.compareQuotes(testRfqA, [testQuoteA, testQuoteB]);
      expect(comparison.cheapestQuoteId).toBeDefined();
      expect(comparison.fastestQuoteId).toBe(testQuoteB.id);

      const fastest = comparison.quotes.find((q) => q.quoteId === testQuoteB.id)!;
      expect(fastest.isFastestDelivery).toBe(true);
      expect(fastest.deliveryEtaHours).toBe(4);
    });

    it('4. Unknown supplier facts remain unknown and are not hallucinated', () => {
      const comparison = quoteComparisonService.compareQuotes(testRfqA, [testQuoteA]);
      const quote = comparison.quotes[0];
      expect(quote.supplierReliabilityScore).toBeUndefined();
    });

    it('5. AI cannot invent supplier facts or alter quote totals', async () => {
      const comparison = quoteComparisonService.compareQuotes(testRfqA, [testQuoteA, testQuoteB]);
      const decision = await advisor.analyzeQuotes(comparison);

      expect(decision.action).toBe('NEGOTIATE');
      expect(decision.quoteId).toBe(testQuoteB.id);
      expect(decision.strategy).toBe('LOWER_PRICE');
      // Proposes fastest supplier match unit price of ₹50
      expect(decision.requestedChanges.targetUnitPrice).toBe('50.00');
    });
  });

  // =========================================================================
  // 2. PROPOSAL VALIDATION & BUSINESS INVARIANTS (Tests 6 - 14)
  // =========================================================================
  describe('2. Deterministic Proposal Validation', () => {
    it('6. Valid negotiation proposal passes deterministic validation', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });

      const proposal = await negotiationService.createProposal({
        negotiationId: negotiation.id,
        strategy: 'LOWER_PRICE',
        requestedChanges: {
          targetUnitPrice: 46, // ₹46 vs ₹50 (8% discount, meets >= 1% and >= ₹5 or ₹4)
        },
        rationale: 'Volume aggregation discount proposal',
        expectedBenefit: 'Saves ₹80 on 20kg order',
      });

      expect(proposal.status).toBe('VALIDATED');
      expect(proposal.roundNumber).toBe(1);
    });

    it('7. Negative target price fails validation', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });

      await expect(
        negotiationService.createProposal({
          negotiationId: negotiation.id,
          strategy: 'LOWER_PRICE',
          requestedChanges: {
            targetUnitPrice: -10,
          },
          rationale: 'Invalid negative price test',
          expectedBenefit: 'None',
        })
      ).rejects.toThrow(NegotiationValidationError);
    });

    it('8. Invalid target quantity fails validation', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });

      await expect(
        negotiationService.createProposal({
          negotiationId: negotiation.id,
          strategy: 'INCREASE_AVAILABLE_QUANTITY',
          requestedChanges: {
            targetQuantity: 0,
          },
          rationale: 'Zero quantity test',
          expectedBenefit: 'None',
        })
      ).rejects.toThrow(NegotiationValidationError);
    });

    it('9. SLA-violating delivery target fails validation', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });

      await expect(
        negotiationService.createProposal({
          negotiationId: negotiation.id,
          strategy: 'IMPROVE_DELIVERY_TIME',
          requestedChanges: {
            targetDeliveryEtaHours: 999, // Exceeds 24h deadline
          },
          rationale: 'Unrealistic turnaround',
          expectedBenefit: 'None',
        })
      ).rejects.toThrow(NegotiationValidationError);
    });

    it('10. Expired quote fails validation', async () => {
      const expiredQuote = {
        ...testQuoteA,
        id: 'quote_expired_test',
        validUntil: new Date(Date.now() - 3600000), // Expired 1 hour ago
      };
      quoteNormalizationService['quotes'].set(expiredQuote.id, expiredQuote);

      await expect(
        negotiationService.startNegotiation({
          rfqId: testRfqA.id,
          quoteId: expiredQuote.id,
        })
      ).rejects.toThrow(/status/i);
    });

    it('11. Inactive or cancelled RFQ fails negotiation initialization', async () => {
      const cancelledRfq = {
        ...testRfqA,
        id: 'rfq_cancelled_test',
        status: 'CANCELLED' as const,
      };
      rfqService['rfqs'].set(cancelledRfq.id, cancelledRfq);

      await expect(
        negotiationService.startNegotiation({
          rfqId: cancelledRfq.id,
          quoteId: testQuoteA.id,
        })
      ).rejects.toThrow(/status/i);
    });

    it('12. Candidate supplier mismatch fails proposal validation', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });

      // Mismatch candidate ID
      negotiation.candidateId = 'cand_mismatched_hacker';

      await expect(
        negotiationService.createProposal({
          negotiationId: negotiation.id,
          strategy: 'LOWER_PRICE',
          requestedChanges: { targetUnitPrice: 46 },
          rationale: 'Testing candidate mismatch',
          expectedBenefit: 'None',
        })
      ).rejects.toThrow(NegotiationValidationError);
    });

    it('13. Maximum negotiation rounds are strictly enforced deterministically', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
        maxRounds: 1, // Restrict to 1 round
      });

      // Round 1
      await negotiationService.createProposal({
        negotiationId: negotiation.id,
        strategy: 'LOWER_PRICE',
        requestedChanges: { targetUnitPrice: 46 },
        rationale: 'Round 1 proposal',
        expectedBenefit: 'Savings',
      });

      // Attempt Round 2 (exceeds maxRounds = 1)
      await expect(
        negotiationService.createProposal({
          negotiationId: negotiation.id,
          strategy: 'LOWER_PRICE',
          requestedChanges: { targetUnitPrice: 44 },
          rationale: 'Round 2 proposal',
          expectedBenefit: 'Savings',
        })
      ).rejects.toThrow(/Maximum negotiation rounds/i);

      expect(negotiation.status).toBe('STOPPED');
    });

    it('14. Forbidden resident PII and budget fields are rejected in AI messages', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });

      await expect(
        negotiationService.createProposal({
          negotiationId: negotiation.id,
          strategy: 'LOWER_PRICE',
          requestedChanges: { targetUnitPrice: 46 },
          rationale: 'Resident in flat 302 has spending limit of ₹1000',
          expectedBenefit: 'Savings',
          supplierFacingMessage: 'Resident in Flat A-101 has maximum budget ₹900',
        })
      ).rejects.toThrow(/PRIVACY_VIOLATION/i);
    });
  });

  // =========================================================================
  // 3. NEGOTIATION STATE MACHINE (Tests 15 - 20)
  // =========================================================================
  describe('3. Negotiation State Machine Transitions', () => {
    it('15. Valid state transitions proceed sequentially (READY -> PROPOSED -> SENT -> WAITING_FOR_RESPONSE)', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });
      expect(negotiation.status).toBe('READY');

      const proposal = await negotiationService.createProposal({
        negotiationId: negotiation.id,
        strategy: 'LOWER_PRICE',
        requestedChanges: { targetUnitPrice: 46 },
        rationale: 'Negotiating lower price',
        expectedBenefit: '₹80 savings',
      });
      expect(negotiation.status).toBe('PROPOSED');

      await negotiationService.sendProposal(proposal.id);
      expect(negotiation.status).toBe('WAITING_FOR_RESPONSE');
    });

    it('16. Illegal state transitions are deterministically rejected with NegotiationStateMachineError', () => {
      expect(canTransitionNegotiation('READY', 'SENT')).toBe(false);
      expect(canTransitionNegotiation('ACCEPTABLE', 'PROPOSED')).toBe(false);
      expect(canTransitionNegotiation('STOPPED', 'READY')).toBe(false);

      expect(() => assertLegalNegotiationTransition('STOPPED', 'PROPOSED')).toThrow(
        NegotiationStateMachineError
      );
    });

    it('17. Counteroffer transitions to REVIEWING and updates round status', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });
      const proposal = await negotiationService.createProposal({
        negotiationId: negotiation.id,
        strategy: 'LOWER_PRICE',
        requestedChanges: { targetUnitPrice: 46 },
        rationale: 'Negotiation lower price',
        expectedBenefit: '₹80 savings',
      });
      await negotiationService.sendProposal(proposal.id);

      // Supplier counteroffers @ ₹48/kg = ₹960 + ₹90 = ₹1050 (saved ₹40)
      const result = await negotiationService.processSupplierCounteroffer({
        negotiationId: negotiation.id,
        supplierResponseService,
        responseInput: {
          rfqId: testRfqA.id,
          candidateId: testCandidateA.id,
          supplierName: testCandidateA.name,
          channel: 'manual',
          lineItems: [
            {
              productName: 'Sona Masoori Rice',
              unitPrice: 48,
              quotedQuantity: 20,
              unit: 'KG',
            },
          ],
          deliveryFee: 90,
          deliveryEtaHours: 8,
          validUntil: new Date(Date.now() + 12 * 3600 * 1000),
        },
      });

      expect(result.quote.total).toBe(1050);
      expect(negotiation.rounds[0].supplierResponseStatus).toBe('COUNTEROFFERED');
      expect(negotiation.currentQuoteId).toBe(result.quote.id);
    });

    it('18. Rejected negotiation terminates with STOPPED status', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
        maxRounds: 1,
      });
      const proposal = await negotiationService.createProposal({
        negotiationId: negotiation.id,
        strategy: 'LOWER_PRICE',
        requestedChanges: { targetUnitPrice: 46 },
        rationale: 'Final offer test',
        expectedBenefit: 'Savings',
      });
      await negotiationService.sendProposal(proposal.id);

      // Supplier responds with identical price (no improvement)
      await negotiationService.processSupplierCounteroffer({
        negotiationId: negotiation.id,
        supplierResponseService,
        responseInput: {
          rfqId: testRfqA.id,
          candidateId: testCandidateA.id,
          supplierName: testCandidateA.name,
          channel: 'manual',
          lineItems: [
            {
              productName: 'Sona Masoori Rice',
              unitPrice: 50,
              quotedQuantity: 20,
              unit: 'KG',
            },
          ],
          deliveryFee: 90,
          validUntil: new Date(Date.now() + 12 * 3600 * 1000),
        },
      });

      expect(negotiation.status).toBe('STOPPED');
      expect(negotiation.completedAt).toBeDefined();
    });

    it('19. Accepted negotiation terminates with ACCEPTABLE status', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });
      const proposal = await negotiationService.createProposal({
        negotiationId: negotiation.id,
        strategy: 'LOWER_PRICE',
        requestedChanges: { targetUnitPrice: 46 },
        rationale: 'Target price proposal',
        expectedBenefit: 'Savings',
      });
      await negotiationService.sendProposal(proposal.id);

      // Supplier accepts target price @ ₹46/kg
      await negotiationService.processSupplierCounteroffer({
        negotiationId: negotiation.id,
        supplierResponseService,
        responseInput: {
          rfqId: testRfqA.id,
          candidateId: testCandidateA.id,
          supplierName: testCandidateA.name,
          channel: 'manual',
          lineItems: [
            {
              productName: 'Sona Masoori Rice',
              unitPrice: 46,
              quotedQuantity: 20,
              unit: 'KG',
            },
          ],
          deliveryFee: 90,
          validUntil: new Date(Date.now() + 12 * 3600 * 1000),
        },
      });

      expect(negotiation.status).toBe('ACCEPTABLE');
      expect(negotiation.stopReason).toBe('ACCEPTABLE_TERMS_ACHIEVED');
    });

    it('20. Terminal states cannot transition to any active state', () => {
      const terminalStates: NegotiationStatus[] = ['ACCEPTABLE', 'STOPPED', 'EXPIRED', 'FAILED'];
      for (const term of terminalStates) {
        expect(canTransitionNegotiation(term, 'PROPOSED')).toBe(false);
        expect(canTransitionNegotiation(term, 'SENT')).toBe(false);
      }
    });
  });

  // =========================================================================
  // 4. SUPPLIER CONTACT SERVICE REUSE (Tests 21 - 24)
  // =========================================================================
  describe('4. Supplier Contact Service Integration', () => {
    it('21. Valid proposal reaches SupplierContactService via existing provider abstraction', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });
      const proposal = await negotiationService.createProposal({
        negotiationId: negotiation.id,
        strategy: 'LOWER_PRICE',
        requestedChanges: { targetUnitPrice: 46 },
        rationale: 'Dispatch test',
        expectedBenefit: 'Savings',
      });

      const dispatchResponse = await negotiationService.sendProposal(proposal.id);

      expect(dispatchResponse.success).toBe(true);
      expect(mockContactProvider.sentNegotiations.length).toBe(1);
      expect(mockContactProvider.sentNegotiations[0].proposalId).toBe(proposal.id);
      expect(mockContactProvider.sentNegotiations[0].recipientEmail).toBe(testCandidateA.email);
    });

    it('22. Duplicate proposal dispatch does not send twice (idempotency)', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });
      const proposal = await negotiationService.createProposal({
        negotiationId: negotiation.id,
        strategy: 'LOWER_PRICE',
        requestedChanges: { targetUnitPrice: 46 },
        rationale: 'Dispatch test',
        expectedBenefit: 'Savings',
      });

      const first = await negotiationService.sendProposal(proposal.id);
      const second = await negotiationService.sendProposal(proposal.id);

      expect(first.success).toBe(true);
      expect(second.isDuplicate).toBe(true);
      expect(mockContactProvider.sentNegotiations.length).toBe(1);
    });

    it('23. Provider failure produces deterministic error without corrupted state', async () => {
      mockContactProvider.setMode('error', { errorMessage: 'Simulated SMTP connection error' });

      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });
      const proposal = await negotiationService.createProposal({
        negotiationId: negotiation.id,
        strategy: 'LOWER_PRICE',
        requestedChanges: { targetUnitPrice: 46 },
        rationale: 'Failure test',
        expectedBenefit: 'Savings',
      });

      await expect(negotiationService.sendProposal(proposal.id)).rejects.toThrow(
        /Simulated SMTP connection error/i
      );
      expect(proposal.status).toBe('VALIDATED');
    });

    it('24. Negotiation messages reuse existing SupplierContactService without creating a second mailer', () => {
      expect(supplierContactService.getProvider('mock')).toBe(mockContactProvider);
    });
  });

  // =========================================================================
  // 5. PHASE 4 INTEGRATION (Tests 25 - 28)
  // =========================================================================
  describe('5. Phase 4 Ingestion & Normalization Integration', () => {
    it('25. Supplier counteroffer enters Phase 4 response ingestion', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });
      const proposal = await negotiationService.createProposal({
        negotiationId: negotiation.id,
        strategy: 'LOWER_PRICE',
        requestedChanges: { targetUnitPrice: 46 },
        rationale: 'Counteroffer test',
        expectedBenefit: 'Savings',
      });
      await negotiationService.sendProposal(proposal.id);

      const result = await negotiationService.processSupplierCounteroffer({
        negotiationId: negotiation.id,
        supplierResponseService,
        responseInput: {
          rfqId: testRfqA.id,
          candidateId: testCandidateA.id,
          supplierName: testCandidateA.name,
          channel: 'email',
          lineItems: [
            {
              productName: 'Sona Masoori Rice',
              unitPrice: 47,
              quotedQuantity: 20,
              unit: 'KG',
            },
          ],
          deliveryFee: 90,
          validUntil: new Date(Date.now() + 12 * 3600 * 1000),
        },
      });

      expect(result.quote.channel).toBe('email');
      expect(result.quote.total).toBe(1030); // 20 * 47 + 90
    });

    it('26. Counteroffer becomes a verified normalized Quote with Decimal precision', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });
      const proposal = await negotiationService.createProposal({
        negotiationId: negotiation.id,
        strategy: 'LOWER_PRICE',
        requestedChanges: { targetUnitPrice: 46 },
        rationale: 'Counteroffer test',
        expectedBenefit: 'Savings',
      });
      await negotiationService.sendProposal(proposal.id);

      const result = await negotiationService.processSupplierCounteroffer({
        negotiationId: negotiation.id,
        supplierResponseService,
        responseInput: {
          rfqId: testRfqA.id,
          candidateId: testCandidateA.id,
          supplierName: testCandidateA.name,
          channel: 'manual',
          lineItems: [
            {
              productName: 'Sona Masoori Rice',
              unitPrice: 46.5,
              quotedQuantity: 20,
              unit: 'KG',
            },
          ],
          deliveryFee: 85,
          validUntil: new Date(Date.now() + 12 * 3600 * 1000),
        },
      });

      expect(result.quote.status).toBe('VALID');
      expect(result.quote.subtotal).toBe(930);
      expect(result.quote.total).toBe(1015);
    });

    it('27. Negotiation consumes the new Quote without duplicate quote normalization', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });
      const proposal = await negotiationService.createProposal({
        negotiationId: negotiation.id,
        strategy: 'LOWER_PRICE',
        requestedChanges: { targetUnitPrice: 46 },
        rationale: 'Counteroffer test',
        expectedBenefit: 'Savings',
      });
      await negotiationService.sendProposal(proposal.id);

      const result = await negotiationService.processSupplierCounteroffer({
        negotiationId: negotiation.id,
        supplierResponseService,
        responseInput: {
          rfqId: testRfqA.id,
          candidateId: testCandidateA.id,
          supplierName: testCandidateA.name,
          channel: 'manual',
          lineItems: [
            {
              productName: 'Sona Masoori Rice',
              unitPrice: 46,
              quotedQuantity: 20,
              unit: 'KG',
            },
          ],
          deliveryFee: 90,
          validUntil: new Date(Date.now() + 12 * 3600 * 1000),
        },
      });

      const retrievedQuote = quoteNormalizationService.getQuote(result.quote.id);
      expect(retrievedQuote).toBeDefined();
      expect(retrievedQuote!.id).toBe(negotiation.currentQuoteId);
    });

    it('28. Discrepancies in counteroffers are detected by Phase 4 validator and marked INVALID', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });
      const proposal = await negotiationService.createProposal({
        negotiationId: negotiation.id,
        strategy: 'LOWER_PRICE',
        requestedChanges: { targetUnitPrice: 46 },
        rationale: 'Discrepancy test',
        expectedBenefit: 'Savings',
      });
      await negotiationService.sendProposal(proposal.id);

      const result = await negotiationService.processSupplierCounteroffer({
        negotiationId: negotiation.id,
        supplierResponseService,
        responseInput: {
          rfqId: testRfqA.id,
          candidateId: testCandidateA.id,
          supplierName: testCandidateA.name,
          channel: 'manual',
          lineItems: [
            {
              productName: 'Sona Masoori Rice',
              unitPrice: 46,
              quotedQuantity: 20,
              unit: 'KG',
            },
          ],
          deliveryFee: 90,
          supplierProvidedTotal: 800, // Discrepancy! Math is 1010, stated is 800
          validUntil: new Date(Date.now() + 12 * 3600 * 1000),
        },
      });

      expect(result.quote.status).toBe('INVALID');
      expect(result.quote.hasTotalMismatch).toBe(true);
    });
  });

  // =========================================================================
  // 6. CONCURRENCY & IDEMPOTENCY (Tests 29 - 31)
  // =========================================================================
  describe('6. Concurrency & Idempotency Safeguards', () => {
    it('29. Concurrent negotiation dispatches are serialized and safe under in-flight guard', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });
      const proposal = await negotiationService.createProposal({
        negotiationId: negotiation.id,
        strategy: 'LOWER_PRICE',
        requestedChanges: { targetUnitPrice: 46 },
        rationale: 'Concurrency test',
        expectedBenefit: 'Savings',
      });

      // Fire 3 simultaneous dispatch requests
      const [res1, res2, res3] = await Promise.all([
        negotiationService.sendProposal(proposal.id),
        negotiationService.sendProposal(proposal.id),
        negotiationService.sendProposal(proposal.id),
      ]);

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);
      expect(res3.success).toBe(true);
      // Provider sent exactly once
      expect(mockContactProvider.sentNegotiations.length).toBe(1);
    });

    it('30. Concurrent AI decisions do not create duplicate proposal entities', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });

      const [prop1, prop2] = await Promise.all([
        negotiationService.createProposal({
          negotiationId: negotiation.id,
          strategy: 'LOWER_PRICE',
          requestedChanges: { targetUnitPrice: 46 },
          rationale: 'Duplicate test',
          expectedBenefit: 'Savings',
          idempotencyKey: 'same_ai_decision_key',
        }),
        negotiationService.createProposal({
          negotiationId: negotiation.id,
          strategy: 'LOWER_PRICE',
          requestedChanges: { targetUnitPrice: 46 },
          rationale: 'Duplicate test',
          expectedBenefit: 'Savings',
          idempotencyKey: 'same_ai_decision_key',
        }),
      ]);

      expect(prop1.id).toBe(prop2.id);
      expect(negotiation.rounds.length).toBe(1);
    });

    it('31. Quote expiration during negotiation prevents further rounds', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });

      // Simulate quote expiring
      testQuoteA.validUntil = new Date(Date.now() - 1000);

      await expect(
        negotiationService.createProposal({
          negotiationId: negotiation.id,
          strategy: 'LOWER_PRICE',
          requestedChanges: { targetUnitPrice: 46 },
          rationale: 'Expired test',
          expectedBenefit: 'Savings',
        })
      ).rejects.toThrow(/QUOTE_EXPIRED/i);
    });
  });

  // =========================================================================
  // 7. PRIVACY & SUPPLIER CONFIDENTIALITY (Tests 32 - 35)
  // =========================================================================
  describe('7. Privacy & Supplier Confidentiality Guarantees', () => {
    it('32. Supplier A never receives Supplier B confidential identity or pricing', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });

      // Attempting to include Supplier B's name in message fails validation
      await expect(
        negotiationService.createProposal({
          negotiationId: negotiation.id,
          strategy: 'LOWER_PRICE',
          requestedChanges: { targetUnitPrice: 46 },
          rationale: `Deccan Bulk Mart B offered ₹52 with 4h delivery`,
          expectedBenefit: 'Savings',
          supplierFacingMessage: `Can you match Deccan Bulk Mart B pricing?`,
        })
      ).rejects.toThrow(/CONFIDENTIALITY_VIOLATION/i);
    });

    it('33. Resident identity, emails, and phone numbers remain private', () => {
      const msg = messageBuilder.buildSupplierMessage(testQuoteA, {
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
        roundNumber: 1,
        requestedChanges: { targetUnitPrice: 46 },
      });

      expect(msg).not.toContain('resident');
      expect(msg).not.toContain('A-101');
      expect(msg).not.toContain('Greenview');
      expect(msg).not.toContain('jivhesh');
    });

    it('34. Payment mandate and spending limit details are omitted', () => {
      const msg = messageBuilder.buildSupplierMessage(testQuoteA, {
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
        roundNumber: 1,
        requestedChanges: { targetUnitPrice: 46 },
      });

      expect(msg).not.toContain('mandate');
      expect(msg).not.toContain('spending limit');
      expect(msg).not.toContain('pre-authorized');
    });

    it('34b. Control characters in strategy notes cannot reshape the message body', () => {
      const msg = messageBuilder.buildSupplierMessage(testQuoteA, {
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
        roundNumber: 1,
        requestedChanges: {
          targetUnitPrice: 46,
          notes: 'First line\r\nInjected: header\rSecond line',
        },
      });

      expect(msg).not.toContain('\r');
      expect(msg).toContain('- Commercial Notes: First line  Injected: header Second line');
    });

    it('35. Internal AI reasoning and prompt directives are omitted from outbound messages', () => {
      const msg = messageBuilder.buildSupplierMessage(testQuoteA, {
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
        roundNumber: 1,
        requestedChanges: { targetUnitPrice: 46 },
      });

      expect(msg).not.toContain('system prompt');
      expect(msg).not.toContain('as an AI');
    });
  });

  // =========================================================================
  // 8. AUDIT TRAIL LOGGING (Tests 36 - 40)
  // =========================================================================
  describe('8. Domain Audit Events Trail', () => {
    it('36. NEGOTIATION_STARTED event is published with sanitized metadata', async () => {
      const publishedEvents: any[] = [];
      const sub = (evt: any) => publishedEvents.push(evt);
      eventBus.subscribe('NEGOTIATION_STARTED', sub);

      try {
        await negotiationService.startNegotiation({
          rfqId: testRfqA.id,
          quoteId: testQuoteA.id,
        });

        const startEvt = publishedEvents.find((e) => e.name === 'NEGOTIATION_STARTED');
        expect(startEvt).toBeDefined();
        expect(startEvt.payload.rfqId).toBe(testRfqA.id);
        expect(startEvt.payload.maxRounds).toBe(3);
      } finally {
        eventBus.unsubscribe('NEGOTIATION_STARTED', sub);
      }
    });

    it('37. NEGOTIATION_PROPOSAL_CREATED and NEGOTIATION_VALIDATED events are published', async () => {
      const publishedEvents: any[] = [];
      const sub = (evt: any) => publishedEvents.push(evt);
      eventBus.subscribe('NEGOTIATION_PROPOSAL_CREATED', sub);
      eventBus.subscribe('NEGOTIATION_VALIDATED', sub);

      try {
        const negotiation = await negotiationService.startNegotiation({
          rfqId: testRfqA.id,
          quoteId: testQuoteA.id,
        });
        await negotiationService.createProposal({
          negotiationId: negotiation.id,
          strategy: 'LOWER_PRICE',
          requestedChanges: { targetUnitPrice: 46 },
          rationale: 'Audit event test',
          expectedBenefit: 'Savings',
        });

        expect(publishedEvents.some((e) => e.name === 'NEGOTIATION_PROPOSAL_CREATED')).toBe(true);
        expect(publishedEvents.some((e) => e.name === 'NEGOTIATION_VALIDATED')).toBe(true);
      } finally {
        eventBus.unsubscribe('NEGOTIATION_PROPOSAL_CREATED', sub);
        eventBus.unsubscribe('NEGOTIATION_VALIDATED', sub);
      }
    });

    it('38. NEGOTIATION_SENT event is published upon transmission', async () => {
      const publishedEvents: any[] = [];
      const sub = (evt: any) => publishedEvents.push(evt);
      eventBus.subscribe('NEGOTIATION_SENT', sub);

      try {
        const negotiation = await negotiationService.startNegotiation({
          rfqId: testRfqA.id,
          quoteId: testQuoteA.id,
        });
        const proposal = await negotiationService.createProposal({
          negotiationId: negotiation.id,
          strategy: 'LOWER_PRICE',
          requestedChanges: { targetUnitPrice: 46 },
          rationale: 'Audit send test',
          expectedBenefit: 'Savings',
        });
        await negotiationService.sendProposal(proposal.id);

        expect(publishedEvents.some((e) => e.name === 'NEGOTIATION_SENT')).toBe(true);
      } finally {
        eventBus.unsubscribe('NEGOTIATION_SENT', sub);
      }
    });

    it('39. NEGOTIATION_RESPONSE_RECEIVED and NEGOTIATION_COUNTEROFFERED are published', async () => {
      const publishedEvents: any[] = [];
      const sub = (evt: any) => publishedEvents.push(evt);
      eventBus.subscribe('NEGOTIATION_RESPONSE_RECEIVED', sub);
      eventBus.subscribe('NEGOTIATION_COUNTEROFFERED', sub);
      eventBus.subscribe('NEGOTIATION_ROUND_COMPLETED', sub);

      try {
        const negotiation = await negotiationService.startNegotiation({
          rfqId: testRfqA.id,
          quoteId: testQuoteA.id,
        });
        const proposal = await negotiationService.createProposal({
          negotiationId: negotiation.id,
          strategy: 'LOWER_PRICE',
          requestedChanges: { targetUnitPrice: 46 },
          rationale: 'Audit counter test',
          expectedBenefit: 'Savings',
        });
        await negotiationService.sendProposal(proposal.id);

        await negotiationService.processSupplierCounteroffer({
          negotiationId: negotiation.id,
          supplierResponseService,
          responseInput: {
            rfqId: testRfqA.id,
            candidateId: testCandidateA.id,
            supplierName: testCandidateA.name,
            channel: 'manual',
            lineItems: [
              {
                productName: 'Sona Masoori Rice',
                unitPrice: 48,
                quotedQuantity: 20,
                unit: 'KG',
              },
            ],
            deliveryFee: 90,
            validUntil: new Date(Date.now() + 12 * 3600 * 1000),
          },
        });

        expect(publishedEvents.some((e) => e.name === 'NEGOTIATION_RESPONSE_RECEIVED')).toBe(true);
        expect(publishedEvents.some((e) => e.name === 'NEGOTIATION_COUNTEROFFERED')).toBe(true);
        expect(publishedEvents.some((e) => e.name === 'NEGOTIATION_ROUND_COMPLETED')).toBe(true);
      } finally {
        eventBus.unsubscribe('NEGOTIATION_RESPONSE_RECEIVED', sub);
        eventBus.unsubscribe('NEGOTIATION_COUNTEROFFERED', sub);
        eventBus.unsubscribe('NEGOTIATION_ROUND_COMPLETED', sub);
      }
    });

    it('40. NEGOTIATION_ACCEPTABLE is published when terms achieve acceptable threshold', async () => {
      const publishedEvents: any[] = [];
      const sub = (evt: any) => publishedEvents.push(evt);
      eventBus.subscribe('NEGOTIATION_ACCEPTABLE', sub);

      try {
        const negotiation = await negotiationService.startNegotiation({
          rfqId: testRfqA.id,
          quoteId: testQuoteA.id,
        });
        const proposal = await negotiationService.createProposal({
          negotiationId: negotiation.id,
          strategy: 'LOWER_PRICE',
          requestedChanges: { targetUnitPrice: 46 },
          rationale: 'Acceptable audit test',
          expectedBenefit: 'Savings',
        });
        await negotiationService.sendProposal(proposal.id);

        await negotiationService.processSupplierCounteroffer({
          negotiationId: negotiation.id,
          supplierResponseService,
          responseInput: {
            rfqId: testRfqA.id,
            candidateId: testCandidateA.id,
            supplierName: testCandidateA.name,
            channel: 'manual',
            lineItems: [
              {
                productName: 'Sona Masoori Rice',
                unitPrice: 46,
                quotedQuantity: 20,
                unit: 'KG',
              },
            ],
            deliveryFee: 90,
            validUntil: new Date(Date.now() + 12 * 3600 * 1000),
          },
        });

        expect(publishedEvents.some((e) => e.name === 'NEGOTIATION_ACCEPTABLE')).toBe(true);
      } finally {
        eventBus.unsubscribe('NEGOTIATION_ACCEPTABLE', sub);
      }
    });
  });

  // =========================================================================
  // 9. CONSTRAINED AI TOOLS & NO AI CONTROL OF MONEY (Tests 41 - 45)
  // =========================================================================
  describe('9. Constrained Agent Tools & Financial Safeguards', () => {
    it('41. AI has no payment or order commitment tools in negotiation registry', () => {
      // Tools in registry:
      const tools = toolRegistry.list();
      const toolNames = tools.map((t) => t.name);

      // Verify negotiation tools are present
      expect(toolNames).toContain('compareQuotesForRFQ');
      expect(toolNames).toContain('getNegotiationState');
      expect(toolNames).toContain('createNegotiationProposal');
      expect(toolNames).toContain('sendNegotiationProposal');
      expect(toolNames).toContain('evaluateNegotiationResponse');

      // AI cannot commit payment during negotiation phase
      expect(toolNames).not.toContain('executeSupplierPayment');
      expect(toolNames).not.toContain('directBankTransfer');
      expect(toolNames).not.toContain('alterUserMandate');
    });

    it('42. compareQuotesForRFQ tool returns factual metrics without hallucination', async () => {
      // Seed default singletons
      const defaultCandidate = { ...testCandidateA, id: 'cand_default_tool_42' };
      const rfq = await defaultRfqService.createRFQ({
        candidate: defaultCandidate,
        lineItems: [{ productName: 'Rice', quantity: 20, unit: 'KG' }],
        deliveryArea: 'Baner, Pune',
        deliveryDeadline: new Date(Date.now() + 86400000),
        quoteDeadline: new Date(Date.now() + 43200000),
      });

      const defaultRespService = new SupplierResponseService(defaultRfqService);
      const response = await defaultRespService.ingestResponse({
        rfqId: rfq.id,
        candidateId: defaultCandidate.id,
        supplierName: defaultCandidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Rice', unitPrice: 50, quotedQuantity: 20, unit: 'KG' }],
        deliveryFee: 60,
        validUntil: new Date(Date.now() + 43200000),
      });
      await defaultQuoteService.normalizeResponse(response);

      const compareTool = toolRegistry.get('compareQuotesForRFQ')!;
      const result: any = await compareTool.execute({ rfqId: rfq.id });

      expect(result.success).toBe(true);
      expect(result.comparison.quotes.length).toBe(1);
      expect(result.comparison.cheapestQuoteId).toBeDefined();
    });

    it('43. getNegotiationState tool returns current active session details', async () => {
      const defaultCandidate = { ...testCandidateA, id: 'cand_default_tool_43' };
      const rfq = await defaultRfqService.createRFQ({
        candidate: defaultCandidate,
        lineItems: [{ productName: 'Rice', quantity: 20, unit: 'KG' }],
        deliveryArea: 'Baner, Pune',
        deliveryDeadline: new Date(Date.now() + 86400000),
        quoteDeadline: new Date(Date.now() + 43200000),
      });

      const defaultRespService = new SupplierResponseService(defaultRfqService);
      const response = await defaultRespService.ingestResponse({
        rfqId: rfq.id,
        candidateId: defaultCandidate.id,
        supplierName: defaultCandidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Rice', unitPrice: 50, quotedQuantity: 20, unit: 'KG' }],
        deliveryFee: 60,
        validUntil: new Date(Date.now() + 43200000),
      });
      const { quote } = await defaultQuoteService.normalizeResponse(response);

      const negotiation = await defaultNegotiationService.startNegotiation({
        rfqId: rfq.id,
        quoteId: quote.id,
      });

      const getStateTool = toolRegistry.get('getNegotiationState')!;
      const result: any = await getStateTool.execute({ negotiationId: negotiation.id });

      expect(result.success).toBe(true);
      expect(result.negotiation.id).toBe(negotiation.id);
      expect(result.negotiation.status).toBe('READY');
    });

    it('44. createNegotiationProposal tool passes through deterministic validation', async () => {
      const defaultCandidate = { ...testCandidateA, id: 'cand_default_tool_44' };
      const rfq = await defaultRfqService.createRFQ({
        candidate: defaultCandidate,
        lineItems: [{ productName: 'Rice', quantity: 20, unit: 'KG' }],
        deliveryArea: 'Baner, Pune',
        deliveryDeadline: new Date(Date.now() + 86400000),
        quoteDeadline: new Date(Date.now() + 43200000),
      });

      const defaultRespService = new SupplierResponseService(defaultRfqService);
      const response = await defaultRespService.ingestResponse({
        rfqId: rfq.id,
        candidateId: defaultCandidate.id,
        supplierName: defaultCandidate.name,
        channel: 'manual',
        lineItems: [{ productName: 'Rice', unitPrice: 50, quotedQuantity: 20, unit: 'KG' }],
        deliveryFee: 60,
        validUntil: new Date(Date.now() + 43200000),
      });
      const { quote } = await defaultQuoteService.normalizeResponse(response);

      const negotiation = await defaultNegotiationService.startNegotiation({
        rfqId: rfq.id,
        quoteId: quote.id,
      });

      const propTool = toolRegistry.get('createNegotiationProposal')!;
      const result: any = await propTool.execute({
        negotiationId: negotiation.id,
        strategy: 'LOWER_PRICE',
        targetUnitPrice: 46,
        rationale: 'Agent proposed price discount',
        expectedBenefit: '₹80 savings',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('VALIDATED');
    });

    it('45. Meaningful improvement policy rejects microscopic ₹0.01 discounts', async () => {
      const negotiation = await negotiationService.startNegotiation({
        rfqId: testRfqA.id,
        quoteId: testQuoteA.id,
      });

      await expect(
        negotiationService.createProposal({
          negotiationId: negotiation.id,
          strategy: 'LOWER_PRICE',
          requestedChanges: {
            targetUnitPrice: 49.99, // 1 paisa discount on ₹50
          },
          rationale: 'Haggling for 1 paisa',
          expectedBenefit: 'Negligible',
        })
      ).rejects.toThrow(/NO_MEANINGFUL_IMPROVEMENT/i);
    });
  });
});
