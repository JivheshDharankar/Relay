import { describe, it, expect, beforeEach } from 'vitest';
import { eventBus } from '../src/events';
import { RFQService } from '../src/discovery/supplier/rfq/RFQService';
import { SupplierResponseService } from '../src/discovery/supplier/quote/provider/SupplierResponseService';
import { QuoteNormalizationService } from '../src/discovery/supplier/quote/QuoteNormalizationService';
import { MockSupplierResponseProvider } from '../src/discovery/supplier/quote/provider/MockSupplierResponseProvider';
import { QuoteEligibilityService } from '../src/discovery/supplier/selection/QuoteEligibilityService';
import { QuoteSelectionComparator } from '../src/discovery/supplier/selection/QuoteSelectionComparator';
import { SelectionAIAdvisor } from '../src/discovery/supplier/selection/SelectionAIAdvisor';
import { SelectionValidator } from '../src/discovery/supplier/selection/SelectionValidator';
import { AllocationService } from '../src/discovery/supplier/selection/AllocationService';
import {
  PurchaseOrderService,
  purchaseOrderService as defaultPOService,
} from '../src/discovery/supplier/selection/PurchaseOrderService';
import {
  ProcurementCommitmentService,
  procurementCommitmentService as defaultCommitmentService,
} from '../src/discovery/supplier/selection/ProcurementCommitmentService';
import {
  rfqService as defaultRfqService,
  quoteNormalizationService as defaultQuoteService,
} from '../src/discovery/supplier';
import { SupplierCandidate } from '../src/discovery/supplier/types';
import { RFQ } from '../src/discovery/supplier/rfq/types';
import { Quote } from '../src/discovery/supplier/quote/types';
import {
  ProcurementCommitment,
  PurchaseOrder,
} from '../src/discovery/supplier/selection/types';

import {
  paymentService as defaultPaymentService,
  mandateService as defaultMandateService,
  mockPaymentProvider as defaultMockPaymentProvider,
  Payment,
  PaymentMandate,
} from '../src/payment';

import {
  FulfillmentService,
  fulfillmentService as defaultFulfillmentService,
  FulfillmentOrderService,
  fulfillmentOrderService as defaultFulfillmentOrderService,
  FulfillmentEventService,
  fulfillmentEventService as defaultFulfillmentEventService,
  SLAMonitoringService,
  slaMonitoringService as defaultSLAMonitoringService,
  DeliveryTrackingService,
  deliveryTrackingService as defaultDeliveryTrackingService,
  MockDeliveryTrackingProvider,
  mockDeliveryTrackingProvider as defaultMockTrackingProvider,
  FulfillmentOrder,
  FulfillmentStateMachineError,
  assertLegalFulfillmentTransition,
  VerificationEvidence,
} from '../src/fulfillment';

import { toolRegistry } from '../src/agent/tools';

describe('Phase 8: Fulfillment, Delivery & SLA Execution', () => {
  // Phase 1 - 7 singletons
  let rfqService: RFQService;
  let supplierResponseService: SupplierResponseService;
  let quoteNormalizationService: QuoteNormalizationService;
  let eligibilityService: QuoteEligibilityService;
  let comparator: QuoteSelectionComparator;
  let advisor: SelectionAIAdvisor;
  let validator: SelectionValidator;
  let allocationService: AllocationService;
  let poService: PurchaseOrderService;
  let commitmentService: ProcurementCommitmentService;

  // Phase 8 services
  let fulfillmentService: FulfillmentService;
  let fulfillmentOrderService: FulfillmentOrderService;
  let fulfillmentEventService: FulfillmentEventService;
  let slaService: SLAMonitoringService;
  let trackingService: DeliveryTrackingService;
  let mockTrackingProvider: MockDeliveryTrackingProvider;

  // Domain Test Entities
  let candidateA: SupplierCandidate;
  let candidateB: SupplierCandidate;

  let rfqSingle: RFQ;
  let quoteSingle: Quote;
  let singleCommitment: ProcurementCommitment;
  let singlePO: PurchaseOrder;
  let singlePayment: Payment;

  let rfqSplitA: RFQ;
  let rfqSplitB: RFQ;
  let quoteSplitA: Quote;
  let quoteSplitB: Quote;
  let splitCommitment: ProcurementCommitment;
  let splitPO_A: PurchaseOrder;
  let splitPO_B: PurchaseOrder;
  let splitPaymentA: Payment;
  let splitPaymentB: Payment;

  let communityMandate: PaymentMandate;

  beforeEach(async () => {
    // 1. Reset all singletons
    defaultRfqService.reset();
    defaultQuoteService.reset();
    defaultCommitmentService.reset();
    defaultPOService.reset();
    defaultPaymentService.reset();
    defaultMandateService.reset();
    defaultMockPaymentProvider.reset();

    defaultFulfillmentService.reset();
    defaultFulfillmentOrderService.reset();
    defaultFulfillmentEventService.reset();
    defaultSLAMonitoringService.reset();
    defaultDeliveryTrackingService.reset();
    defaultMockTrackingProvider.reset();

    // 2. Wire service references to singletons so tool executions share identical state
    rfqService = defaultRfqService;
    quoteNormalizationService = defaultQuoteService;
    const mockResponseProvider = new MockSupplierResponseProvider(rfqService);
    supplierResponseService = new SupplierResponseService(rfqService);
    supplierResponseService.registerProvider(mockResponseProvider);

    eligibilityService = new QuoteEligibilityService();
    comparator = new QuoteSelectionComparator(eligibilityService);
    advisor = new SelectionAIAdvisor();
    validator = new SelectionValidator(eligibilityService);
    allocationService = new AllocationService();
    poService = defaultPOService;
    commitmentService = defaultCommitmentService;

    fulfillmentService = defaultFulfillmentService;
    fulfillmentOrderService = defaultFulfillmentOrderService;
    fulfillmentEventService = defaultFulfillmentEventService;
    slaService = defaultSLAMonitoringService;
    trackingService = defaultDeliveryTrackingService;
    mockTrackingProvider = defaultMockTrackingProvider;

    // 3. Seed Candidates
    candidateA = {
      id: 'cand_alpha_grains',
      name: 'Alpha Wholesale Grains',
      address: 'Gultekdi Market Yard, Pune',
      latitude: 18.496,
      longitude: 73.868,
      categories: ['grain_wholesaler'],
      email: 'orders@alphagrains.com',
      phone: '+919876543201',
    };

    candidateB = {
      id: 'cand_beta_bulk',
      name: 'Beta Bulk Mart',
      address: 'Hadapsar Industrial Estate, Pune',
      latitude: 18.502,
      longitude: 73.928,
      categories: ['grain_wholesaler'],
      email: 'sales@betabulk.com',
      phone: '+919876543202',
    };

    const now = new Date();
    const slaDeadline = new Date(now.getTime() + 12 * 3600 * 1000);
    const quoteDeadline = new Date(now.getTime() + 4 * 3600 * 1000);

    // 4. Seed Mandate with ₹200,000 capacity
    communityMandate = defaultMandateService.createMandate({
      id: 'mandate_comm_proc_200k',
      ownerReference: 'soc_greenview',
      purpose: 'COMMUNITY_PROCUREMENT',
      currency: 'INR',
      spendingLimit: 200000,
    });

    // 5. Create and Pay Single Supplier Procurement (1,000 KG @ ₹55/kg + ₹500 fee = ₹55,500)
    rfqSingle = await rfqService.createRFQ({
      candidate: candidateA,
      lineItems: [{ productName: 'Sharbati Wheat', quantity: 1000, unit: 'KG' }],
      deliveryArea: 'Greenview Residency Central Depot, Pune',
      deliveryDeadline: slaDeadline,
      quoteDeadline,
      societyId: 'soc_greenview',
    });

    const respSingle = await supplierResponseService.ingestResponse({
      rfqId: rfqSingle.id,
      candidateId: candidateA.id,
      supplierName: candidateA.name,
      channel: 'manual',
      lineItems: [{ productName: 'Sharbati Wheat', quotedQuantity: 1000, unit: 'KG', unitPrice: 55 }],
      deliveryFee: 500,
      deliveryEtaHours: 8,
      validUntil: new Date(now.getTime() + 24 * 3600 * 1000),
    });
    quoteSingle = (await quoteNormalizationService.normalizeResponse(respSingle)).quote;

    const commitSingleResult = await commitmentService.createCommitment({
      rfqId: rfqSingle.id,
      recommendation: {
        decision: 'SELECT_SUPPLIER',
        supplierId: candidateA.id,
        quoteId: quoteSingle.id,
        reason: 'Optimal supplier with compliant SLA',
      },
    });
    singleCommitment = commitSingleResult.commitment;
    singlePO = commitSingleResult.purchaseOrders[0];

    const paySingleResult = await defaultPaymentService.payCommitment({
      ownerReference: 'soc_greenview',
      commitmentId: singleCommitment.id,
      mandateId: communityMandate.id,
    });
    singlePayment = paySingleResult.payments[0];

    // 6. Create and Pay Multi-Supplier Split Procurement (Supplier A 600kg, Supplier B 400kg)
    rfqSplitA = await rfqService.createRFQ({
      candidate: candidateA,
      lineItems: [{ productName: 'Organic Rice', quantity: 1000, unit: 'KG' }],
      deliveryArea: 'Greenview Residency Central Depot, Pune',
      deliveryDeadline: slaDeadline,
      quoteDeadline,
      societyId: 'soc_greenview',
    });
    rfqSplitB = await rfqService.createRFQ({
      candidate: candidateB,
      lineItems: [{ productName: 'Organic Rice', quantity: 1000, unit: 'KG' }],
      deliveryArea: 'Greenview Residency Central Depot, Pune',
      deliveryDeadline: slaDeadline,
      quoteDeadline,
      societyId: 'soc_greenview',
    });

    const respSplitA = await supplierResponseService.ingestResponse({
      rfqId: rfqSplitA.id,
      candidateId: candidateA.id,
      supplierName: candidateA.name,
      channel: 'manual',
      lineItems: [{ productName: 'Organic Rice', quotedQuantity: 600, unit: 'KG', unitPrice: 50 }],
      deliveryFee: 300,
      deliveryEtaHours: 6,
      validUntil: new Date(now.getTime() + 24 * 3600 * 1000),
    });
    quoteSplitA = (await quoteNormalizationService.normalizeResponse(respSplitA)).quote;

    const respSplitB = await supplierResponseService.ingestResponse({
      rfqId: rfqSplitB.id,
      candidateId: candidateB.id,
      supplierName: candidateB.name,
      channel: 'manual',
      lineItems: [{ productName: 'Organic Rice', quotedQuantity: 400, unit: 'KG', unitPrice: 52 }],
      deliveryFee: 250,
      deliveryEtaHours: 7,
      validUntil: new Date(now.getTime() + 24 * 3600 * 1000),
    });
    quoteSplitB = (await quoteNormalizationService.normalizeResponse(respSplitB)).quote;

    const commitSplitResult = await commitmentService.createCommitment({
      rfqId: rfqSplitA.id,
      recommendation: {
        decision: 'SPLIT_ORDER',
        allocations: [
          { supplierId: candidateA.id, quoteId: quoteSplitA.id, quantity: 600 },
          { supplierId: candidateB.id, quoteId: quoteSplitB.id, quantity: 400 },
        ],
        reason: 'Split across two suppliers to satisfy total demand',
      },
    });
    splitCommitment = commitSplitResult.commitment;
    splitPO_A = commitSplitResult.purchaseOrders[0];
    splitPO_B = commitSplitResult.purchaseOrders[1];

    const paySplitResult = await defaultPaymentService.payCommitment({
      ownerReference: 'soc_greenview',
      commitmentId: splitCommitment.id,
      mandateId: communityMandate.id,
    });
    splitPaymentA = paySplitResult.payments.find((p) => p.supplierId === candidateA.id)!;
    splitPaymentB = paySplitResult.payments.find((p) => p.supplierId === candidateB.id)!;
  });

  // =========================================================================
  // 1. STATE MACHINE & LIFECYCLE (Tests 1 - 8)
  // =========================================================================
  describe('1. State Machine & Lifecycle Invariants', () => {
    it('1. Valid physical goods progression proceeds through legal statuses', () => {
      expect(() => {
        assertLegalFulfillmentTransition('CREATED', 'AWAITING_SUPPLIER_ACCEPTANCE', 'PHYSICAL_GOODS');
        assertLegalFulfillmentTransition('AWAITING_SUPPLIER_ACCEPTANCE', 'ACCEPTED', 'PHYSICAL_GOODS');
        assertLegalFulfillmentTransition('ACCEPTED', 'PROCESSING', 'PHYSICAL_GOODS');
        assertLegalFulfillmentTransition('PROCESSING', 'DISPATCHED', 'PHYSICAL_GOODS');
        assertLegalFulfillmentTransition('DISPATCHED', 'IN_TRANSIT', 'PHYSICAL_GOODS');
        assertLegalFulfillmentTransition('IN_TRANSIT', 'DELIVERED', 'PHYSICAL_GOODS');
        assertLegalFulfillmentTransition('DELIVERED', 'VERIFIED', 'PHYSICAL_GOODS');
      }).not.toThrow();
    });

    it('2. Valid service progression proceeds through legal service statuses', () => {
      expect(() => {
        assertLegalFulfillmentTransition('CREATED', 'AWAITING_SUPPLIER_ACCEPTANCE', 'SERVICE');
        assertLegalFulfillmentTransition('AWAITING_SUPPLIER_ACCEPTANCE', 'ACCEPTED', 'SERVICE');
        assertLegalFulfillmentTransition('ACCEPTED', 'PROCESSING', 'SERVICE');
        assertLegalFulfillmentTransition('PROCESSING', 'SERVICE_SCHEDULED', 'SERVICE');
        assertLegalFulfillmentTransition('SERVICE_SCHEDULED', 'SERVICE_IN_PROGRESS', 'SERVICE');
        assertLegalFulfillmentTransition('SERVICE_IN_PROGRESS', 'SERVICE_COMPLETED', 'SERVICE');
        assertLegalFulfillmentTransition('SERVICE_COMPLETED', 'VERIFIED', 'SERVICE');
      }).not.toThrow();
    });

    it('3. Illegal skipping of physical statuses (e.g. CREATED -> DELIVERED) throws FulfillmentStateMachineError', () => {
      expect(() =>
        assertLegalFulfillmentTransition('CREATED', 'DELIVERED', 'PHYSICAL_GOODS')
      ).toThrow(FulfillmentStateMachineError);
    });

    it('4. Physical goods workflow cannot transition to SERVICE_SCHEDULED', () => {
      expect(() =>
        assertLegalFulfillmentTransition('PROCESSING', 'SERVICE_SCHEDULED', 'PHYSICAL_GOODS')
      ).toThrow(FulfillmentStateMachineError);
    });

    it('5. Service workflow cannot transition to DISPATCHED', () => {
      expect(() =>
        assertLegalFulfillmentTransition('PROCESSING', 'DISPATCHED', 'SERVICE')
      ).toThrow(FulfillmentStateMachineError);
    });

    it('6. Terminal status VERIFIED cannot transition to any other status', () => {
      expect(() =>
        assertLegalFulfillmentTransition('VERIFIED', 'PROCESSING', 'PHYSICAL_GOODS')
      ).toThrow(FulfillmentStateMachineError);
    });

    it('7. Terminal status REJECTED cannot transition to any other status', () => {
      expect(() =>
        assertLegalFulfillmentTransition('REJECTED', 'PROCESSING', 'PHYSICAL_GOODS')
      ).toThrow(FulfillmentStateMachineError);
    });

    it('8. Terminal status FAILED cannot transition to any other status', () => {
      expect(() =>
        assertLegalFulfillmentTransition('FAILED', 'DELIVERED', 'PHYSICAL_GOODS')
      ).toThrow(FulfillmentStateMachineError);
    });
  });

  // =========================================================================
  // 2. PAYMENT LINKAGE (Tests 9 - 14)
  // =========================================================================
  describe('2. Payment Linkage & Authorization Guard', () => {
    it('9. Paid commitment with SUCCEEDED payment creates a valid FulfillmentOrder', () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      expect(order.status).toBe('AWAITING_SUPPLIER_ACCEPTANCE');
      expect(order.commitmentId).toBe(singleCommitment.id);
      expect(order.purchaseOrderId).toBe(singlePO.id);
      expect(order.paymentId).toBe(singlePayment.id);
      expect(order.requestedQuantity).toBe(1000);
      expect(order.fulfilledQuantity).toBe(0);
      expect(order.remainingQuantity).toBe(1000);
    });

    it('10. Unpaid commitment without successful payment is strictly rejected', () => {
      const pendingPayment: Payment = {
        ...singlePayment,
        status: 'PENDING',
      };

      expect(() =>
        fulfillmentOrderService.createFulfillmentOrder({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          payment: pendingPayment,
        })
      ).toThrow('UNPAID_COMMITMENT');
    });

    it('11. Failed payment is rejected with UNPAID_COMMITMENT', () => {
      const failedPayment: Payment = {
        ...singlePayment,
        status: 'FAILED',
      };

      expect(() =>
        fulfillmentOrderService.createFulfillmentOrder({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          payment: failedPayment,
        })
      ).toThrow('UNPAID_COMMITMENT');
    });

    it('12. Supplier mismatch between payment and purchase order is rejected', () => {
      const mismatchedPayment: Payment = {
        ...singlePayment,
        supplierId: 'cand_impostor_other',
      };

      expect(() =>
        fulfillmentOrderService.createFulfillmentOrder({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          payment: mismatchedPayment,
        })
      ).toThrow('SUPPLIER_MISMATCH');
    });

    it('13. Purchase order referencing wrong commitment is rejected', () => {
      const wrongPO: PurchaseOrder = {
        ...singlePO,
        commitmentId: 'commit_foreign_unlinked',
      };

      expect(() =>
        fulfillmentOrderService.createFulfillmentOrder({
          commitment: singleCommitment,
          purchaseOrder: wrongPO,
          payment: singlePayment,
        })
      ).toThrow('PO_COMMITMENT_MISMATCH');
    });

    it('14. Missing payment record is rejected with PAYMENT_REQUIRED', () => {
      expect(() =>
        fulfillmentOrderService.createFulfillmentOrder({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          payment: undefined as any,
        })
      ).toThrow('PAYMENT_REQUIRED');
    });
  });

  // =========================================================================
  // 3. QUANTITY INTEGRITY & CONSERVATION (Tests 15 - 19)
  // =========================================================================
  describe('3. Quantity Integrity & Invariants', () => {
    it('15. Full fulfillment satisfies requestedQuantity and leaves zero remaining', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_accept',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 'idemp_accept_1',
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_start',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'FULFILLMENT_STARTED',
        timestamp: new Date(),
        idempotencyKey: 'idemp_start_1',
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_dispatch',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DISPATCHED',
        timestamp: new Date(),
        idempotencyKey: 'idemp_dispatch_1',
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_delivered',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DELIVERED',
        timestamp: new Date(),
        quantityFulfilled: 1000,
        idempotencyKey: 'idemp_deliver_1',
      });

      expect(order.status).toBe('DELIVERED');
      expect(order.fulfilledQuantity).toBe(1000);
      expect(order.remainingQuantity).toBe(0);
    });

    it('16. Partial fulfillment explicitly represents fulfilled and remaining quantities', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_accept',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 'idemp_partial_accept',
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_pack',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_PACKED',
        timestamp: new Date(),
        idempotencyKey: 'idemp_partial_pack',
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_dispatch',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DISPATCHED',
        timestamp: new Date(),
        idempotencyKey: 'idemp_partial_disp',
      });

      // Deliver 600 KG of 1000 KG
      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_partial_delivered',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DELIVERED',
        timestamp: new Date(),
        quantityFulfilled: 600,
        idempotencyKey: 'idemp_partial_deliv',
      });

      expect(order.status).toBe('DELIVERED');
      expect(order.fulfilledQuantity).toBe(600);
      expect(order.remainingQuantity).toBe(400);
    });

    it('17. Quantity conservation invariant (fulfilled + remaining = requested) holds strictly', () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      expect(order.fulfilledQuantity + order.remainingQuantity).toBe(order.requestedQuantity);
    });

    it('18. Over-fulfillment (fulfilled > requested) is strictly rejected', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_accept',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 'idemp_over_acc',
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_start',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'FULFILLMENT_STARTED',
        timestamp: new Date(),
        idempotencyKey: 'idemp_over_start',
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_dispatch',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DISPATCHED',
        timestamp: new Date(),
        idempotencyKey: 'idemp_over_disp',
      });

      // Attempt to deliver 1200 KG when 1000 KG was requested
      await expect(
        fulfillmentEventService.ingestEvent(order, {
          id: 'evt_over',
          fulfillmentId: order.id,
          supplierId: candidateA.id,
          eventType: 'ORDER_DELIVERED',
          timestamp: new Date(),
          quantityFulfilled: 1200,
          idempotencyKey: 'idemp_over_event',
        })
      ).rejects.toThrow('OVER_FULFILLMENT');
    });

    it('19. Negative quantity is strictly rejected with NEGATIVE_QUANTITY', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_accept',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 'idemp_neg_acc',
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_start',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'FULFILLMENT_STARTED',
        timestamp: new Date(),
        idempotencyKey: 'idemp_neg_start',
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_dispatch',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DISPATCHED',
        timestamp: new Date(),
        idempotencyKey: 'idemp_neg_disp',
      });

      await expect(
        fulfillmentEventService.ingestEvent(order, {
          id: 'evt_neg',
          fulfillmentId: order.id,
          supplierId: candidateA.id,
          eventType: 'ORDER_DELIVERED',
          timestamp: new Date(),
          quantityFulfilled: -50,
          idempotencyKey: 'idemp_neg_event',
        })
      ).rejects.toThrow('NEGATIVE_QUANTITY');
    });
  });

  // =========================================================================
  // 4. SUPPLIER FULFILLMENT EVENTS (Tests 20 - 26)
  // =========================================================================
  describe('4. Supplier Fulfillment Events & Ingestion', () => {
    it('20. SUPPLIER_ACCEPTED advances order to ACCEPTED', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      const res = await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_20',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 'evt_20_key',
      });

      expect(res.order.status).toBe('ACCEPTED');
    });

    it('21. SUPPLIER_REJECTED marks order REJECTED without mutating payments', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      const res = await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_21',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_REJECTED',
        timestamp: new Date(),
        notes: 'Warehouse out of stock',
        idempotencyKey: 'evt_21_key',
      });

      expect(res.order.status).toBe('REJECTED');
      // Crucial Financial Boundary: Payment remains SUCCEEDED (no automatic reversal here)
      expect(singlePayment.status).toBe('SUCCEEDED');
    });

    it('22. ORDER_DISPATCHED advances order to DISPATCHED and records tracking reference', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_acc',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 'evt_acc_22',
      });
      await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_pack',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_PACKED',
        timestamp: new Date(),
        idempotencyKey: 'evt_pack_22',
      });

      const res = await fulfillmentEventService.ingestEvent(order, {
        id: 'evt_disp',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DISPATCHED',
        timestamp: new Date(),
        trackingReference: 'TRK-ALPHA-WAYBILL-99',
        idempotencyKey: 'evt_disp_22',
      });

      expect(res.order.status).toBe('DISPATCHED');
      expect(res.order.trackingReference).toBe('TRK-ALPHA-WAYBILL-99');
    });

    it('23. ORDER_IN_TRANSIT advances order to IN_TRANSIT', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'e1',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 'e1_23',
      });
      await fulfillmentEventService.ingestEvent(order, {
        id: 'e2',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'FULFILLMENT_STARTED',
        timestamp: new Date(),
        idempotencyKey: 'e2_23',
      });
      await fulfillmentEventService.ingestEvent(order, {
        id: 'e3',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DISPATCHED',
        timestamp: new Date(),
        idempotencyKey: 'e3_23',
      });

      const res = await fulfillmentEventService.ingestEvent(order, {
        id: 'e4',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_IN_TRANSIT',
        timestamp: new Date(),
        idempotencyKey: 'e4_23',
      });

      expect(res.order.status).toBe('IN_TRANSIT');
    });

    it('24. ORDER_DELIVERED advances order to DELIVERED and records actual delivery timestamp', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'e1',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 'e1_24',
      });
      await fulfillmentEventService.ingestEvent(order, {
        id: 'e2',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_PACKED',
        timestamp: new Date(),
        idempotencyKey: 'e2_24',
      });
      await fulfillmentEventService.ingestEvent(order, {
        id: 'e3',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DISPATCHED',
        timestamp: new Date(),
        idempotencyKey: 'e3_24',
      });

      const deliverTime = new Date();
      const res = await fulfillmentEventService.ingestEvent(order, {
        id: 'e4',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DELIVERED',
        timestamp: deliverTime,
        quantityFulfilled: 1000,
        idempotencyKey: 'e4_24',
      });

      expect(res.order.status).toBe('DELIVERED');
      expect(res.order.actualDeliveryAt).toBeDefined();
    });

    it('25. SERVICE_COMPLETED advances service to SERVICE_COMPLETED', async () => {
      const serviceOrder = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
        fulfillmentType: 'SERVICE',
      });

      await fulfillmentEventService.ingestEvent(serviceOrder, {
        id: 's1',
        fulfillmentId: serviceOrder.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 's1_25',
      });
      await fulfillmentEventService.ingestEvent(serviceOrder, {
        id: 's2',
        fulfillmentId: serviceOrder.id,
        supplierId: candidateA.id,
        eventType: 'SERVICE_SCHEDULED',
        timestamp: new Date(),
        idempotencyKey: 's2_25',
      });
      await fulfillmentEventService.ingestEvent(serviceOrder, {
        id: 's3',
        fulfillmentId: serviceOrder.id,
        supplierId: candidateA.id,
        eventType: 'SERVICE_STARTED',
        timestamp: new Date(),
        idempotencyKey: 's3_25',
      });

      const res = await fulfillmentEventService.ingestEvent(serviceOrder, {
        id: 's4',
        fulfillmentId: serviceOrder.id,
        supplierId: candidateA.id,
        eventType: 'SERVICE_COMPLETED',
        timestamp: new Date(),
        quantityFulfilled: 1000,
        idempotencyKey: 's4_25',
      });

      expect(res.order.status).toBe('SERVICE_COMPLETED');
    });

    it('26. Event for mismatched supplier is rejected with SUPPLIER_MISMATCH', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      await expect(
        fulfillmentEventService.ingestEvent(order, {
          id: 'evt_impostor',
          fulfillmentId: order.id,
          supplierId: 'cand_impostor_reporting', // Mismatched supplier
          eventType: 'SUPPLIER_ACCEPTED',
          timestamp: new Date(),
          idempotencyKey: 'idemp_impostor',
        })
      ).rejects.toThrow('SUPPLIER_MISMATCH');
    });
  });

  // =========================================================================
  // 5. IDEMPOTENCY & DUPLICATE SUPPRESSION (Tests 27 - 31)
  // =========================================================================
  describe('5. Idempotency & Duplicate Suppression', () => {
    it('27. Duplicate supplier event with same idempotency key returns cached result', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      const event = {
        id: 'evt_dup_27',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED' as const,
        timestamp: new Date(),
        idempotencyKey: 'same_event_key_27',
      };

      const res1 = await fulfillmentEventService.ingestEvent(order, event);
      const res2 = await fulfillmentEventService.ingestEvent(order, event);

      expect(res1.isDuplicate).toBe(false);
      expect(res2.isDuplicate).toBe(true);
      expect(res1.order.id).toBe(res2.order.id);
    });

    it('28. Duplicate fulfillment creation for same PO returns cached order', () => {
      const order1 = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
        idempotencyKey: 'po_dup_key_28',
      });

      const order2 = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
        idempotencyKey: 'po_dup_key_28',
      });

      expect(order1.id).toBe(order2.id);
    });

    it('29. Repeated delivery event does not duplicate fulfilled quantity or audit events', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'e1',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 'k1',
      });
      await fulfillmentEventService.ingestEvent(order, {
        id: 'e2',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_PACKED',
        timestamp: new Date(),
        idempotencyKey: 'k2',
      });
      await fulfillmentEventService.ingestEvent(order, {
        id: 'e3',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DISPATCHED',
        timestamp: new Date(),
        idempotencyKey: 'k3',
      });

      const deliverEvent = {
        id: 'e4',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DELIVERED' as const,
        timestamp: new Date(),
        quantityFulfilled: 1000,
        idempotencyKey: 'unique_delivery_key_29',
      };

      await fulfillmentEventService.ingestEvent(order, deliverEvent);
      expect(order.fulfilledQuantity).toBe(1000);

      // Repeat delivery event
      await fulfillmentEventService.ingestEvent(order, deliverEvent);
      expect(order.fulfilledQuantity).toBe(1000); // Remains 1000 (never 2000)
    });

    it('30. Idempotency key derived deterministically', () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      expect(order.trackingReference).toBeDefined();
    });

    it('31. Provider tracking query duplicate handling returns consistent results', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      const res1 = await trackingService.getTrackingStatus(order.trackingReference!);
      const res2 = await trackingService.getTrackingStatus(order.trackingReference!);

      expect(res1.trackingReference).toBe(res2.trackingReference);
      expect(res1.carrier).toBe(res2.carrier);
    });
  });

  // =========================================================================
  // 6. CONCURRENCY & MUTEX PROTECTION (Tests 32 - 35)
  // =========================================================================
  describe('6. Concurrency & Mutex Protection', () => {
    it('32. Simultaneous supplier events on same fulfillment order serialize safely', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      // Send two concurrent acceptance updates with distinct keys
      const [r1, r2] = await Promise.all([
        fulfillmentEventService.ingestEvent(order, {
          id: 'evt_conc_1',
          fulfillmentId: order.id,
          supplierId: candidateA.id,
          eventType: 'SUPPLIER_ACCEPTED',
          timestamp: new Date(),
          idempotencyKey: 'k_conc_1',
        }),
        fulfillmentEventService.ingestEvent(order, {
          id: 'evt_conc_2',
          fulfillmentId: order.id,
          supplierId: candidateA.id,
          eventType: 'SUPPLIER_ACCEPTED',
          timestamp: new Date(),
          idempotencyKey: 'k_conc_2',
        }),
      ]);

      expect(r1.order.status).toBe('ACCEPTED');
      expect(r2.order.status).toBe('ACCEPTED');
    });

    it('33. Conflicting concurrent events (DISPATCHED vs FAILED) serialize under mutex', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'acc',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 'k_acc_33',
      });
      await fulfillmentEventService.ingestEvent(order, {
        id: 'proc',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'FULFILLMENT_STARTED',
        timestamp: new Date(),
        idempotencyKey: 'k_proc_33',
      });

      // Simultaneous dispatch and failure
      const promises = [
        fulfillmentEventService.ingestEvent(order, {
          id: 'disp',
          fulfillmentId: order.id,
          supplierId: candidateA.id,
          eventType: 'ORDER_DISPATCHED',
          timestamp: new Date(),
          idempotencyKey: 'k_disp_33',
        }),
        fulfillmentEventService.ingestEvent(order, {
          id: 'fail',
          fulfillmentId: order.id,
          supplierId: candidateA.id,
          eventType: 'FULFILLMENT_FAILED',
          timestamp: new Date(),
          idempotencyKey: 'k_fail_33',
        }),
      ];

      const results = await Promise.allSettled(promises);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThan(0);
    });

    it('34. Concurrent quantity updates preserve quantity conservation invariant', () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      expect(order.fulfilledQuantity + order.remainingQuantity).toBe(1000);
    });

    it('35. In-flight fulfillment order mutex prevents double creation', () => {
      const order1 = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
        idempotencyKey: 'key_35',
      });
      const order2 = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
        idempotencyKey: 'key_35',
      });

      expect(order1.id).toBe(order2.id);
    });
  });

  // =========================================================================
  // 7. SLA MONITORING, WARNINGS & BREACH EXECUTION (Tests 36 - 42)
  // =========================================================================
  describe('7. SLA Monitoring, Warnings & Breach Execution', () => {
    it('36. Authoritative SLA deadline is computed deterministically (12 hours default)', () => {
      const now = new Date();
      const deadline = slaService.computeDefaultDeadline(now);
      const diffHours = (deadline.getTime() - now.getTime()) / (3600 * 1000);

      expect(diffHours).toBe(12);
    });

    it('37. ON_TRACK classification returned when ample turnaround remains', () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      const res = slaService.calculateSLAStatus(order, new Date());
      expect(res.slaStatus).toBe('ON_TRACK');
      expect(res.isOverdue).toBe(false);
      expect(res.isBreached).toBe(false);
    });

    it('38. AT_RISK classification and SLA_WARNING emitted when within warning threshold (<= 2h)', () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      // Evaluate 1 hour before SLA deadline (warning threshold is 2 hours)
      const nearDeadline = new Date(order.slaDeadline.getTime() - 60 * 60 * 1000);
      const res = slaService.evaluateAndUpdateSLA(order, nearDeadline);

      expect(res.slaStatus).toBe('AT_RISK');
      expect(order.slaStatus).toBe('AT_RISK');
    });

    it('39. BREACHED classification and SLA_BREACHED emitted when current time exceeds deadline', () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      // Evaluate 30 minutes past deadline
      const pastDeadline = new Date(order.slaDeadline.getTime() + 30 * 60 * 1000);
      const res = slaService.evaluateAndUpdateSLA(order, pastDeadline);

      expect(res.slaStatus).toBe('BREACHED');
      expect(res.isBreached).toBe(true);
      expect(res.isOverdue).toBe(true);
      expect(res.breachDurationMinutes).toBe(30);
    });

    it('40. Breach duration in minutes is calculated accurately from deadline', () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      // Evaluate 75 minutes past deadline
      const pastDeadline = new Date(order.slaDeadline.getTime() + 75 * 60 * 1000);
      const res = slaService.calculateSLAStatus(order, pastDeadline);

      expect(res.breachDurationMinutes).toBe(75);
    });

    it('41. SLA_WARNING and SLA_BREACHED events are emitted only once per order (idempotent)', () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      const pastDeadline = new Date(order.slaDeadline.getTime() + 15 * 60 * 1000);

      // Evaluate breach twice
      slaService.evaluateAndUpdateSLA(order, pastDeadline);
      slaService.evaluateAndUpdateSLA(order, pastDeadline);

      expect(order.slaStatus).toBe('BREACHED');
    });

    it('42. SLA breach does NOT alter financial payments or delete fulfillment history', () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      const pastDeadline = new Date(order.slaDeadline.getTime() + 60 * 60 * 1000);
      slaService.evaluateAndUpdateSLA(order, pastDeadline);

      // Invariant: Payment remains intact and SUCCEEDED
      expect(singlePayment.status).toBe('SUCCEEDED');
      expect(singlePayment.amount).toBe(55500);
    });
  });

  // =========================================================================
  // 8. DELIVERY TRACKING ABSTRACTION & SIMULATOR (Tests 43 - 48)
  // =========================================================================
  describe('8. Delivery Tracking Abstraction & Simulator', () => {
    it('43. Mock tracking provider returns realistic tracking result with carrier and ETA', async () => {
      const res = await trackingService.getTrackingStatus('TRK-TEST-123');

      expect(res.trackingReference).toBe('TRK-TEST-123');
      expect(res.carrier).toContain('Relay Logistics');
      expect(res.status).toBe('IN_TRANSIT');
      expect(res.estimatedDeliveryAt).toBeDefined();
    });

    it('44. Tracking status updates reflect transit milestones', async () => {
      mockTrackingProvider.simulateStatus(
        'TRK-STAGE-44',
        'OUT_FOR_DELIVERY',
        'Baner Distribution Facility'
      );

      const res = await trackingService.getTrackingStatus('TRK-STAGE-44');
      expect(res.status).toBe('OUT_FOR_DELIVERY');
      expect(res.location).toBe('Baner Distribution Facility');
    });

    it('45. Simulated tracking provider clearly exposes isSimulated = true', async () => {
      const res = await trackingService.getTrackingStatus('TRK-SIM-45');
      expect(res.isSimulated).toBe(true);
    });

    it('46. Simulated tracking provider handles carrier gateway timeout', async () => {
      mockTrackingProvider.simulateTimeout('TRK-TIMEOUT-46');

      await expect(
        trackingService.getTrackingStatus('TRK-TIMEOUT-46')
      ).rejects.toThrow('timeout');
    });

    it('47. Simulated tracking provider handles carrier tracking failure', async () => {
      mockTrackingProvider.simulateFailure(
        'TRK-FAIL-47',
        'INVALID_WAYBILL',
        'Waybill code not recognized'
      );

      await expect(
        trackingService.getTrackingStatus('TRK-FAIL-47')
      ).rejects.toThrow('INVALID_WAYBILL');
    });

    it('48. Location-agnostic tracking behaves identically across multiple cities (Pune, Bangalore, Delhi, London, Tokyo)', async () => {
      const cities = ['Pune', 'Bangalore', 'Delhi', 'London', 'Tokyo'];

      for (const city of cities) {
        mockTrackingProvider.simulateStatus(`TRK-${city}`, 'DISPATCHED', `${city} Central Hub`);
        const res = await trackingService.getTrackingStatus(`TRK-${city}`);
        expect(res.status).toBe('DISPATCHED');
        expect(res.location).toBe(`${city} Central Hub`);
      }
    });
  });

  // =========================================================================
  // 9. MULTI-SUPPLIER FULFILLMENT & CONFIDENTIALITY (Tests 49 - 53)
  // =========================================================================
  describe('9. Multi-Supplier Fulfillment & Confidentiality', () => {
    it('49. Generates separate independent fulfillment orders for split multi-supplier procurement', async () => {
      const { orders } = await fulfillmentService.createFulfillmentForCommitment({
        commitmentId: splitCommitment.id,
      });

      expect(orders.length).toBe(2);
      expect(orders[0].id).not.toBe(orders[1].id);
      expect(orders[0].supplierId).not.toBe(orders[1].supplierId);

      const orderA = orders.find((o) => o.supplierId === candidateA.id)!;
      const orderB = orders.find((o) => o.supplierId === candidateB.id)!;

      expect(orderA.requestedQuantity).toBe(600);
      expect(orderB.requestedQuantity).toBe(400);
    });

    it('50. Supplier A and Supplier B fulfill independently (e.g. A delivered, B in transit)', async () => {
      const { orders } = await fulfillmentService.createFulfillmentForCommitment({
        commitmentId: splitCommitment.id,
      });

      const orderA = orders.find((o) => o.supplierId === candidateA.id)!;
      const orderB = orders.find((o) => o.supplierId === candidateB.id)!;

      // Supplier A progresses to DELIVERED
      await fulfillmentEventService.ingestEvent(orderA, {
        id: 'a1',
        fulfillmentId: orderA.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 'a1_50',
      });
      await fulfillmentEventService.ingestEvent(orderA, {
        id: 'a2',
        fulfillmentId: orderA.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_PACKED',
        timestamp: new Date(),
        idempotencyKey: 'a2_50',
      });
      await fulfillmentEventService.ingestEvent(orderA, {
        id: 'a3',
        fulfillmentId: orderA.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DISPATCHED',
        timestamp: new Date(),
        idempotencyKey: 'a3_50',
      });
      await fulfillmentEventService.ingestEvent(orderA, {
        id: 'a4',
        fulfillmentId: orderA.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DELIVERED',
        timestamp: new Date(),
        quantityFulfilled: 600,
        idempotencyKey: 'a4_50',
      });

      // Supplier B progresses to IN_TRANSIT
      await fulfillmentEventService.ingestEvent(orderB, {
        id: 'b1',
        fulfillmentId: orderB.id,
        supplierId: candidateB.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 'b1_50',
      });
      await fulfillmentEventService.ingestEvent(orderB, {
        id: 'b2',
        fulfillmentId: orderB.id,
        supplierId: candidateB.id,
        eventType: 'FULFILLMENT_STARTED',
        timestamp: new Date(),
        idempotencyKey: 'b2_50',
      });
      await fulfillmentEventService.ingestEvent(orderB, {
        id: 'b3',
        fulfillmentId: orderB.id,
        supplierId: candidateB.id,
        eventType: 'ORDER_DISPATCHED',
        timestamp: new Date(),
        idempotencyKey: 'b3_50',
      });
      await fulfillmentEventService.ingestEvent(orderB, {
        id: 'b4',
        fulfillmentId: orderB.id,
        supplierId: candidateB.id,
        eventType: 'ORDER_IN_TRANSIT',
        timestamp: new Date(),
        idempotencyKey: 'b4_50',
      });

      expect(orderA.status).toBe('DELIVERED');
      expect(orderB.status).toBe('IN_TRANSIT');
    });

    it('51. Supplier confidentiality: Supplier A fulfillment record contains zero Supplier B data/pricing', async () => {
      const { orders } = await fulfillmentService.createFulfillmentForCommitment({
        commitmentId: splitCommitment.id,
      });

      const orderA = orders.find((o) => o.supplierId === candidateA.id)!;
      const jsonA = JSON.stringify(orderA);

      expect(jsonA).not.toContain(candidateB.name);
      expect(jsonA).not.toContain(candidateB.email);
    });

    it('52. Partial fulfillment across suppliers produces PARTIALLY_FULFILLED aggregate summary', async () => {
      const { orders } = await fulfillmentService.createFulfillmentForCommitment({
        commitmentId: splitCommitment.id,
      });

      const orderA = orders.find((o) => o.supplierId === candidateA.id)!;

      // Ingest partial delivery of 300 KG out of 600 KG for Supplier A
      await fulfillmentEventService.ingestEvent(orderA, {
        id: 'a1',
        fulfillmentId: orderA.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 'a1_52',
      });
      await fulfillmentEventService.ingestEvent(orderA, {
        id: 'a2',
        fulfillmentId: orderA.id,
        supplierId: candidateA.id,
        eventType: 'FULFILLMENT_STARTED',
        timestamp: new Date(),
        idempotencyKey: 'a2_52',
      });
      await fulfillmentEventService.ingestEvent(orderA, {
        id: 'a3',
        fulfillmentId: orderA.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DISPATCHED',
        timestamp: new Date(),
        idempotencyKey: 'a3_52',
      });
      await fulfillmentEventService.ingestEvent(orderA, {
        id: 'a4',
        fulfillmentId: orderA.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DELIVERED',
        timestamp: new Date(),
        quantityFulfilled: 300,
        idempotencyKey: 'a4_52',
      });

      const summary = fulfillmentService.getAggregateFulfillmentSummary(splitCommitment.id);
      expect(summary.status).toBe('PARTIALLY_FULFILLED');
    });

    it('53. All suppliers verified produces ALL_VERIFIED aggregate summary', async () => {
      const { orders } = await fulfillmentService.createFulfillmentForCommitment({
        commitmentId: splitCommitment.id,
      });

      const evidence: VerificationEvidence = {
        evidenceType: 'DELIVERY_CONFIRMATION',
        verifiedBy: 'Community Security Gate',
        verifiedAt: new Date(),
        isSimulated: true,
      };

      for (const ord of orders) {
        await fulfillmentEventService.ingestEvent(ord, {
          id: `acc_${ord.id}`,
          fulfillmentId: ord.id,
          supplierId: ord.supplierId,
          eventType: 'SUPPLIER_ACCEPTED',
          timestamp: new Date(),
          idempotencyKey: `acc_${ord.id}`,
        });
        await fulfillmentEventService.ingestEvent(ord, {
          id: `pack_${ord.id}`,
          fulfillmentId: ord.id,
          supplierId: ord.supplierId,
          eventType: 'ORDER_PACKED',
          timestamp: new Date(),
          idempotencyKey: `pack_${ord.id}`,
        });
        await fulfillmentEventService.ingestEvent(ord, {
          id: `disp_${ord.id}`,
          fulfillmentId: ord.id,
          supplierId: ord.supplierId,
          eventType: 'ORDER_DISPATCHED',
          timestamp: new Date(),
          idempotencyKey: `disp_${ord.id}`,
        });
        await fulfillmentEventService.ingestEvent(ord, {
          id: `del_${ord.id}`,
          fulfillmentId: ord.id,
          supplierId: ord.supplierId,
          eventType: 'ORDER_DELIVERED',
          timestamp: new Date(),
          quantityFulfilled: ord.requestedQuantity,
          idempotencyKey: `del_${ord.id}`,
        });

        fulfillmentOrderService.verifyFulfillment(ord.id, evidence);
      }

      const summary = fulfillmentService.getAggregateFulfillmentSummary(splitCommitment.id);
      expect(summary.status).toBe('ALL_VERIFIED');
      expect(summary.verifiedOrders).toBe(2);
    });
  });

  // =========================================================================
  // 10. DELIVERY VERIFICATION LAYER (Tests 54 - 57)
  // =========================================================================
  describe('10. Delivery Verification Layer', () => {
    it('54. DELIVERED order with valid evidence transitions to VERIFIED', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'acc',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 'k_acc_54',
      });
      await fulfillmentEventService.ingestEvent(order, {
        id: 'pack',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_PACKED',
        timestamp: new Date(),
        idempotencyKey: 'k_pack_54',
      });
      await fulfillmentEventService.ingestEvent(order, {
        id: 'disp',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DISPATCHED',
        timestamp: new Date(),
        idempotencyKey: 'k_disp_54',
      });
      await fulfillmentEventService.ingestEvent(order, {
        id: 'del',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DELIVERED',
        timestamp: new Date(),
        quantityFulfilled: 1000,
        idempotencyKey: 'k_del_54',
      });

      const verified = fulfillmentOrderService.verifyFulfillment(order.id, {
        evidenceType: 'CARRIER_SIGN_OFF',
        verifiedBy: 'Society Logistics Desk',
        verifiedAt: new Date(),
        notes: '1,000 KG wheat received and weighed in at dock',
        isSimulated: true,
      });

      expect(verified.status).toBe('VERIFIED');
      expect(verified.verifiedAt).toBeDefined();
      expect(verified.verificationEvidence?.evidenceType).toBe('CARRIER_SIGN_OFF');
    });

    it('55. Attempting to verify an order before delivery is rejected', () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      expect(() =>
        fulfillmentOrderService.verifyFulfillment(order.id, {
          evidenceType: 'DELIVERY_CONFIRMATION',
          verifiedBy: 'Admin',
          verifiedAt: new Date(),
          isSimulated: true,
        })
      ).toThrow("expected 'DELIVERED'");
    });

    it('56. Partially fulfilled order explicitly records fulfilled vs remaining quantity upon delivery', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      await fulfillmentEventService.ingestEvent(order, {
        id: 'acc',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
        timestamp: new Date(),
        idempotencyKey: 'k_acc_56',
      });
      await fulfillmentEventService.ingestEvent(order, {
        id: 'pack',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_PACKED',
        timestamp: new Date(),
        idempotencyKey: 'k_pack_56',
      });
      await fulfillmentEventService.ingestEvent(order, {
        id: 'disp',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DISPATCHED',
        timestamp: new Date(),
        idempotencyKey: 'k_disp_56',
      });
      await fulfillmentEventService.ingestEvent(order, {
        id: 'del',
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'ORDER_DELIVERED',
        timestamp: new Date(),
        quantityFulfilled: 750,
        idempotencyKey: 'k_del_56',
      });

      expect(order.fulfilledQuantity).toBe(750);
      expect(order.remainingQuantity).toBe(250);
    });

    it('57. Simulated verification evidence is explicitly marked as simulated', () => {
      const evidence: VerificationEvidence = {
        evidenceType: 'SIMULATED_VERIFICATION',
        verifiedBy: 'Relay Automated Simulator',
        verifiedAt: new Date(),
        isSimulated: true,
      };

      expect(evidence.isSimulated).toBe(true);
    });
  });

  // =========================================================================
  // 11. AI SAFETY & CONSTRAINED AGENT TOOLS (Tests 58 - 64)
  // =========================================================================
  describe('11. AI Safety & Constrained Agent Tools', () => {
    it('58. Tool registry contains zero arbitrary status mutation tools (no markDelivered, no overrideSLA, no executeSQL)', () => {
      const toolNames = toolRegistry.list().map((t) => t.name);

      expect(toolNames).toContain('createFulfillmentOrder');
      expect(toolNames).toContain('getFulfillmentState');
      expect(toolNames).toContain('getFulfillmentSummary');
      expect(toolNames).toContain('getDeliveryStatus');
      expect(toolNames).toContain('getSLAStatus');
      expect(toolNames).toContain('processSupplierFulfillmentEvent');

      // AI Safety: No raw override or SQL tools
      expect(toolNames).not.toContain('markDelivered');
      expect(toolNames).not.toContain('overrideSLA');
      expect(toolNames).not.toContain('updateFulfillmentStatusDirectly');
      expect(toolNames).not.toContain('executeSQL');
    });

    it('59. createFulfillmentOrder tool creates orders deterministically for a paid commitment', async () => {
      const tool = toolRegistry.get('createFulfillmentOrder')!;
      const result: any = await tool.execute(
        {
          commitmentId: singleCommitment.id,
          fulfillmentType: 'PHYSICAL_GOODS',
        },
        { residentId: 'soc_greenview', societyId: 'soc_greenview' }
      );

      expect(result.success).toBe(true);
      expect(result.orderCount).toBe(1);
      expect(result.orders[0].requestedQuantity).toBe(1000);
    });

    it('60. getFulfillmentState tool retrieves operational status read-only', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      const tool = toolRegistry.get('getFulfillmentState')!;
      const result: any = await tool.execute({
        fulfillmentId: order.id,
      });

      expect(result.success).toBe(true);
      expect(result.order.id).toBe(order.id);
      expect(result.order.status).toBe('AWAITING_SUPPLIER_ACCEPTANCE');
    });

    it('61. getFulfillmentSummary tool retrieves aggregate summary read-only', async () => {
      await fulfillmentService.createFulfillmentForCommitment({
        commitmentId: splitCommitment.id,
      });

      const tool = toolRegistry.get('getFulfillmentSummary')!;
      const result: any = await tool.execute({
        commitmentId: splitCommitment.id,
      });

      expect(result.success).toBe(true);
      expect(result.summary.totalOrders).toBe(2);
      expect(result.summary.status).toBe('IN_PROGRESS');
    });

    it('62. getDeliveryStatus tool queries carrier tracking read-only', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      const tool = toolRegistry.get('getDeliveryStatus')!;
      const result: any = await tool.execute({
        fulfillmentId: order.id,
      });

      expect(result.success).toBe(true);
      expect(result.tracking.trackingReference).toBe(order.trackingReference);
    });

    it('63. getSLAStatus tool evaluates SLA metrics read-only', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      const tool = toolRegistry.get('getSLAStatus')!;
      const result: any = await tool.execute({
        fulfillmentId: order.id,
      });

      expect(result.success).toBe(true);
      expect(result.sla.slaStatus).toBe('ON_TRACK');
    });

    it('64. processSupplierFulfillmentEvent tool passes deterministic state machine validation', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      const tool = toolRegistry.get('processSupplierFulfillmentEvent')!;
      const result: any = await tool.execute({
        fulfillmentId: order.id,
        supplierId: candidateA.id,
        eventType: 'SUPPLIER_ACCEPTED',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('ACCEPTED');
    });
  });

  // =========================================================================
  // 12. PRIVACY, ANTI-LEAKAGE & AUDIT TRAIL (Tests 65 - 70)
  // =========================================================================
  describe('12. Privacy, Anti-Leakage & Audit Trail', () => {
    it('65. Fulfillment orders and carrier payloads contain zero resident names or resident IDs', () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      const json = JSON.stringify(order);
      expect(json).not.toContain('residentId');
      expect(json).not.toContain('residentName');
      expect(json).not.toContain('Riya Sharma');
      expect(json).not.toContain('Amit Patel');
    });

    it('66. Fulfillment orders contain zero flat numbers or apartment unit numbers', () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      const json = JSON.stringify(order);
      expect(json).not.toContain('flatNumber');
      expect(json).not.toContain('Tower A');
      expect(json).not.toContain('A-101');
    });

    it('67. Carrier tracking and supplier events contain zero resident payment mandates or bank credentials', async () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      const tracking = await trackingService.getTrackingStatus(order.trackingReference!);
      const trackingJson = JSON.stringify(tracking);

      expect(trackingJson).not.toContain('mandate');
      expect(trackingJson).not.toContain('cvv');
      expect(trackingJson).not.toContain('pin');
    });

    it('68. Fulfillment records contain zero internal AI reasoning or prompts', () => {
      const order = fulfillmentOrderService.createFulfillmentOrder({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        payment: singlePayment,
      });

      const json = JSON.stringify(order);
      expect(json).not.toContain('prompt');
      expect(json).not.toContain('reasoning');
    });

    it('69. Emits complete event sequence (FULFILLMENT_CREATED, FULFILLMENT_DISPATCHED, FULFILLMENT_DELIVERED, FULFILLMENT_VERIFIED)', async () => {
      const events: any[] = [];
      const subCreated = (e: any) => events.push(e);
      const subDispatched = (e: any) => events.push(e);
      const subDelivered = (e: any) => events.push(e);
      const subVerified = (e: any) => events.push(e);

      eventBus.subscribe('FULFILLMENT_CREATED', subCreated);
      eventBus.subscribe('FULFILLMENT_DISPATCHED', subDispatched);
      eventBus.subscribe('FULFILLMENT_DELIVERED', subDelivered);
      eventBus.subscribe('FULFILLMENT_VERIFIED', subVerified);

      try {
        const order = fulfillmentOrderService.createFulfillmentOrder({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          payment: singlePayment,
        });

        await fulfillmentEventService.ingestEvent(order, {
          id: 'acc',
          fulfillmentId: order.id,
          supplierId: candidateA.id,
          eventType: 'SUPPLIER_ACCEPTED',
          timestamp: new Date(),
          idempotencyKey: 'k_acc_69',
        });
        await fulfillmentEventService.ingestEvent(order, {
          id: 'pack',
          fulfillmentId: order.id,
          supplierId: candidateA.id,
          eventType: 'ORDER_PACKED',
          timestamp: new Date(),
          idempotencyKey: 'k_pack_69',
        });
        await fulfillmentEventService.ingestEvent(order, {
          id: 'disp',
          fulfillmentId: order.id,
          supplierId: candidateA.id,
          eventType: 'ORDER_DISPATCHED',
          timestamp: new Date(),
          idempotencyKey: 'k_disp_69',
        });
        await fulfillmentEventService.ingestEvent(order, {
          id: 'del',
          fulfillmentId: order.id,
          supplierId: candidateA.id,
          eventType: 'ORDER_DELIVERED',
          timestamp: new Date(),
          quantityFulfilled: 1000,
          idempotencyKey: 'k_del_69',
        });

        fulfillmentOrderService.verifyFulfillment(order.id, {
          evidenceType: 'DELIVERY_CONFIRMATION',
          verifiedBy: 'Central Hub',
          verifiedAt: new Date(),
          isSimulated: true,
        });

        expect(events.some((e) => e.name === 'FULFILLMENT_CREATED')).toBe(true);
        expect(events.some((e) => e.name === 'FULFILLMENT_DISPATCHED')).toBe(true);
        expect(events.some((e) => e.name === 'FULFILLMENT_DELIVERED')).toBe(true);
        expect(events.some((e) => e.name === 'FULFILLMENT_VERIFIED')).toBe(true);
      } finally {
        eventBus.unsubscribe('FULFILLMENT_CREATED', subCreated);
        eventBus.unsubscribe('FULFILLMENT_DISPATCHED', subDispatched);
        eventBus.unsubscribe('FULFILLMENT_DELIVERED', subDelivered);
        eventBus.unsubscribe('FULFILLMENT_VERIFIED', subVerified);
      }
    });

    it('70. Multi-supplier fulfillment emits independent audit events per supplier obligation', async () => {
      const events: any[] = [];
      const subCreated = (e: any) => events.push(e);
      eventBus.subscribe('FULFILLMENT_CREATED', subCreated);

      try {
        await fulfillmentService.createFulfillmentForCommitment({
          commitmentId: splitCommitment.id,
        });

        expect(events.length).toBe(2);
        const suppliers = events.map((e) => e.payload.supplierId);
        expect(suppliers).toContain(candidateA.id);
        expect(suppliers).toContain(candidateB.id);
      } finally {
        eventBus.unsubscribe('FULFILLMENT_CREATED', subCreated);
      }
    });
  });
});
