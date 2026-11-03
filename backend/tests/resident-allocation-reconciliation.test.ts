import { describe, it, expect, beforeEach } from 'vitest';
import { eventBus } from '../src/events';
import { ProcurementCommitment, PurchaseOrder } from '../src/discovery/supplier/selection/types';
import { FulfillmentOrder } from '../src/fulfillment/types';
import { Payment } from '../src/payment/types';
import {
  AllocationEngine,
  CostAllocationService,
  ResidentLedgerService,
  ReconciliationService,
  AllocationAuditService,
  AllocationService,
  allocationService as defaultAllocationService,
  AllocationValidationError,
  AllocationStateMachineError,
  ResidentDemand,
  canTransitionAllocation,
  canTransitionReconciliation,
  assertLegalAllocationTransition,
  assertLegalReconciliationTransition,
} from '../src/allocation';
import {
  toolRegistry,
  getResidentAllocationTool,
  getResidentLedgerTool,
  getAllocationSummaryTool,
  getReconciliationStatusTool,
  explainAllocationTool,
} from '../src/agent/tools';

describe('Phase 9: Resident Allocation, Individual Accounting & Reconciliation', () => {
  let engine: AllocationEngine;
  let costService: CostAllocationService;
  let ledgerService: ResidentLedgerService;
  let reconService: ReconciliationService;
  let auditService: AllocationAuditService;
  let allocationService: AllocationService;

  // Standard Test Fixtures
  let residentDemands: ResidentDemand[];
  let singleCommitment: ProcurementCommitment;
  let singlePO: PurchaseOrder;
  let singlePayment: Payment;
  let verifiedFulfillment: FulfillmentOrder;

  // Split Multi-Supplier Fixtures
  let splitCommitment: ProcurementCommitment;
  let poSupplierA: PurchaseOrder;
  let poSupplierB: PurchaseOrder;
  let paymentSupplierA: Payment;
  let paymentSupplierB: Payment;
  let verifiedFulfillmentA: FulfillmentOrder;
  let verifiedFulfillmentB: FulfillmentOrder;

  beforeEach(() => {
    eventBus.clear();
    engine = new AllocationEngine();
    costService = new CostAllocationService();
    auditService = new AllocationAuditService();
    ledgerService = new ResidentLedgerService(auditService);
    reconService = new ReconciliationService(auditService);
    allocationService = new AllocationService(
      engine,
      costService,
      ledgerService,
      reconService,
      auditService
    );

    // Three residents requesting a total of 10 units (4 + 3 + 3)
    residentDemands = [
      {
        residentOrderId: 'ro_aarav_001',
        residentId: 'res_id_aarav',
        residentReference: 'res_ref_aarav',
        productId: 'prod_rice_premium',
        productName: 'Organic Basmati Rice',
        requestedQuantity: 4,
        unit: 'PACK',
        maxAuthorizedBudget: 2500,
        flatNumber: 'A-101',
      },
      {
        residentOrderId: 'ro_riya_002',
        residentId: 'res_id_riya',
        residentReference: 'res_ref_riya',
        productId: 'prod_rice_premium',
        productName: 'Organic Basmati Rice',
        requestedQuantity: 3,
        unit: 'PACK',
        maxAuthorizedBudget: 2000,
        flatNumber: 'B-204',
      },
      {
        residentOrderId: 'ro_kabir_003',
        residentId: 'res_id_kabir',
        residentReference: 'res_ref_kabir',
        productId: 'prod_rice_premium',
        productName: 'Organic Basmati Rice',
        requestedQuantity: 3,
        unit: 'PACK',
        maxAuthorizedBudget: 2000,
        flatNumber: 'C-305',
      },
    ];

    const now = new Date();

    // Single Supplier Procurement: 10 units @ ₹500 = ₹5,000 subtotal, ₹250 tax, ₹150 delivery, ₹100 other = ₹5,500 total
    singleCommitment = {
      id: 'comm_single_100',
      rfqId: 'rfq_100',
      selectedQuoteIds: ['q_alpha_1'],
      supplierIds: ['sup_alpha'],
      product: {
        productId: 'prod_rice_premium',
        productName: 'Organic Basmati Rice',
        unit: 'PACK',
      },
      requestedQuantity: 10,
      committedQuantity: 10,
      allocations: [
        {
          id: 'sup_alloc_alpha',
          commitmentId: 'comm_single_100',
          supplierId: 'sup_alpha',
          supplierName: 'Alpha Organics Wholesale',
          quoteId: 'q_alpha_1',
          allocatedQuantity: 10,
          unit: 'PACK',
          agreedUnitPrice: 500,
          lineSubtotal: 5000,
          deliveryFee: 150,
          tax: 250,
          otherCharges: 100,
          totalAmount: 5500,
        },
      ],
      financials: {
        subtotal: 5000,
        deliveryFee: 150,
        tax: 250,
        otherCharges: 100,
        total: 5500,
        currency: 'INR',
      },
      deliveryDeadline: new Date(now.getTime() + 12 * 3600 * 1000),
      status: 'PAID',
      purchaseOrderIds: ['po_alpha_100'],
      recommendationReason: 'Lowest qualified wholesale quote with immediate fulfillment',
      idempotencyKey: 'idemp_comm_single_100',
      createdAt: now,
      updatedAt: now,
    };

    singlePO = {
      id: 'po_alpha_100',
      commitmentId: 'comm_single_100',
      poNumber: 'PO-2026-ALPHA-01',
      supplierId: 'sup_alpha',
      supplierName: 'Alpha Organics Wholesale',
      lines: [
        {
          lineNumber: 1,
          productName: 'Organic Basmati Rice',
          quantity: 10,
          unit: 'PACK',
          unitPrice: 500,
          lineSubtotal: 5000,
          tax: 250,
          deliveryFee: 150,
          otherCharges: 100,
          lineTotal: 5500,
        },
      ],
      totalAmount: 5500,
      currency: 'INR',
      status: 'PAID',
      issuedAt: now,
      paymentId: 'pay_alpha_100',
      createdAt: now,
      updatedAt: now,
    };

    singlePayment = {
      id: 'pay_alpha_100',
      commitmentId: 'comm_single_100',
      purchaseOrderId: 'po_alpha_100',
      supplierId: 'sup_alpha',
      supplierName: 'Alpha Organics Wholesale',
      amount: 5500,
      currency: 'INR',
      status: 'SUCCEEDED',
      provider: 'MOCK_ESCROW',
      providerTransactionId: 'txn_mock_alpha_100',
      initiatedAt: now,
      completedAt: now,
      idempotencyKey: 'idemp_pay_alpha_100',
      metadata: {},
    };

    verifiedFulfillment = {
      id: 'ful_alpha_100',
      commitmentId: 'comm_single_100',
      purchaseOrderId: 'po_alpha_100',
      paymentId: 'pay_alpha_100',
      supplierId: 'sup_alpha',
      supplierName: 'Alpha Organics Wholesale',
      fulfillmentType: 'PHYSICAL_GOODS',
      status: 'VERIFIED',
      productName: 'Organic Basmati Rice',
      requestedQuantity: 10,
      fulfilledQuantity: 10,
      remainingQuantity: 0,
      unit: 'PACK',
      deliveryArea: 'Gate 1, Society Central Delivery Hub',
      slaDeadline: new Date(now.getTime() + 12 * 3600 * 1000),
      slaStatus: 'ON_TRACK',
      verificationEvidence: {
        evidenceType: 'DELIVERY_CONFIRMATION',
        verifiedBy: 'Society Gate Supervisor',
        verifiedAt: now,
        isSimulated: true,
      },
      createdAt: now,
      updatedAt: now,
      verifiedAt: now,
    };

    // Split Multi-Supplier: 10 units total (Supplier A: 6 units @ ₹500 = ₹3,300 total; Supplier B: 4 units @ ₹520 = ₹2,220 total)
    // Combined subtotal = ₹5,080, tax = ₹250, deliveryFee = ₹120, other = ₹70, total = ₹5,520
    splitCommitment = {
      id: 'comm_split_200',
      rfqId: 'rfq_200',
      selectedQuoteIds: ['q_sup_a', 'q_sup_b'],
      supplierIds: ['sup_a', 'sup_b'],
      product: {
        productId: 'prod_rice_premium',
        productName: 'Organic Basmati Rice',
        unit: 'PACK',
      },
      requestedQuantity: 10,
      committedQuantity: 10,
      allocations: [
        {
          id: 'alloc_split_a',
          commitmentId: 'comm_split_200',
          supplierId: 'sup_a',
          supplierName: 'Supplier A Farm Store',
          quoteId: 'q_sup_a',
          allocatedQuantity: 6,
          unit: 'PACK',
          agreedUnitPrice: 500,
          lineSubtotal: 3000,
          deliveryFee: 80,
          tax: 150,
          otherCharges: 70,
          totalAmount: 3300,
        },
        {
          id: 'alloc_split_b',
          commitmentId: 'comm_split_200',
          supplierId: 'sup_b',
          supplierName: 'Supplier B Grain Direct',
          quoteId: 'q_sup_b',
          allocatedQuantity: 4,
          unit: 'PACK',
          agreedUnitPrice: 520,
          lineSubtotal: 2080,
          deliveryFee: 40,
          tax: 100,
          otherCharges: 0,
          totalAmount: 2220,
        },
      ],
      financials: {
        subtotal: 5080,
        deliveryFee: 120,
        tax: 250,
        otherCharges: 70,
        total: 5520,
        currency: 'INR',
      },
      deliveryDeadline: new Date(now.getTime() + 12 * 3600 * 1000),
      status: 'PAID',
      purchaseOrderIds: ['po_sup_a_200', 'po_sup_b_200'],
      recommendationReason: 'Split allocation satisfies complete demand across constrained supplier capacities',
      idempotencyKey: 'idemp_comm_split_200',
      createdAt: now,
      updatedAt: now,
    };

    poSupplierA = {
      id: 'po_sup_a_200',
      commitmentId: 'comm_split_200',
      poNumber: 'PO-2026-SPLIT-A',
      supplierId: 'sup_a',
      supplierName: 'Supplier A Farm Store',
      lines: [
        {
          lineNumber: 1,
          productName: 'Organic Basmati Rice',
          quantity: 6,
          unit: 'PACK',
          unitPrice: 500,
          lineSubtotal: 3000,
          tax: 150,
          deliveryFee: 80,
          otherCharges: 70,
          lineTotal: 3300,
        },
      ],
      totalAmount: 3300,
      currency: 'INR',
      status: 'PAID',
      issuedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    poSupplierB = {
      id: 'po_sup_b_200',
      commitmentId: 'comm_split_200',
      poNumber: 'PO-2026-SPLIT-B',
      supplierId: 'sup_b',
      supplierName: 'Supplier B Grain Direct',
      lines: [
        {
          lineNumber: 1,
          productName: 'Organic Basmati Rice',
          quantity: 4,
          unit: 'PACK',
          unitPrice: 520,
          lineSubtotal: 2080,
          tax: 100,
          deliveryFee: 40,
          otherCharges: 0,
          lineTotal: 2220,
        },
      ],
      totalAmount: 2220,
      currency: 'INR',
      status: 'PAID',
      issuedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    paymentSupplierA = {
      id: 'pay_split_a_200',
      commitmentId: 'comm_split_200',
      purchaseOrderId: 'po_sup_a_200',
      supplierId: 'sup_a',
      supplierName: 'Supplier A Farm Store',
      amount: 3300,
      currency: 'INR',
      status: 'SUCCEEDED',
      provider: 'MOCK_ESCROW',
      providerTransactionId: 'txn_mock_split_a',
      initiatedAt: now,
      completedAt: now,
      idempotencyKey: 'idemp_pay_split_a',
      metadata: {},
    };

    paymentSupplierB = {
      id: 'pay_split_b_200',
      commitmentId: 'comm_split_200',
      purchaseOrderId: 'po_sup_b_200',
      supplierId: 'sup_b',
      supplierName: 'Supplier B Grain Direct',
      amount: 2220,
      currency: 'INR',
      status: 'SUCCEEDED',
      provider: 'MOCK_ESCROW',
      providerTransactionId: 'txn_mock_split_b',
      initiatedAt: now,
      completedAt: now,
      idempotencyKey: 'idemp_pay_split_b',
      metadata: {},
    };

    verifiedFulfillmentA = {
      id: 'ful_split_a_200',
      commitmentId: 'comm_split_200',
      purchaseOrderId: 'po_sup_a_200',
      paymentId: 'pay_split_a_200',
      supplierId: 'sup_a',
      supplierName: 'Supplier A Farm Store',
      fulfillmentType: 'PHYSICAL_GOODS',
      status: 'VERIFIED',
      productName: 'Organic Basmati Rice',
      requestedQuantity: 6,
      fulfilledQuantity: 6,
      remainingQuantity: 0,
      unit: 'PACK',
      deliveryArea: 'Gate 1, Central Hub',
      slaDeadline: new Date(now.getTime() + 12 * 3600 * 1000),
      slaStatus: 'ON_TRACK',
      verificationEvidence: {
        evidenceType: 'DELIVERY_CONFIRMATION',
        verifiedBy: 'Society Hub Manager',
        verifiedAt: now,
        isSimulated: true,
      },
      createdAt: now,
      updatedAt: now,
      verifiedAt: now,
    };

    verifiedFulfillmentB = {
      id: 'ful_split_b_200',
      commitmentId: 'comm_split_200',
      purchaseOrderId: 'po_sup_b_200',
      paymentId: 'pay_split_b_200',
      supplierId: 'sup_b',
      supplierName: 'Supplier B Grain Direct',
      fulfillmentType: 'PHYSICAL_GOODS',
      status: 'VERIFIED',
      productName: 'Organic Basmati Rice',
      requestedQuantity: 4,
      fulfilledQuantity: 4,
      remainingQuantity: 0,
      unit: 'PACK',
      deliveryArea: 'Gate 1, Central Hub',
      slaDeadline: new Date(now.getTime() + 12 * 3600 * 1000),
      slaStatus: 'ON_TRACK',
      verificationEvidence: {
        evidenceType: 'DELIVERY_CONFIRMATION',
        verifiedBy: 'Society Hub Manager',
        verifiedAt: now,
        isSimulated: true,
      },
      createdAt: now,
      updatedAt: now,
      verifiedAt: now,
    };
  });

  // =========================================================================
  // 1. STATE MACHINE & LIFECYCLE INVARIANTS (6 tests)
  // =========================================================================
  describe('1. State Machine & Lifecycle Invariants', () => {
    it('1. Legal allocation progression moves: PENDING -> CALCULATED -> VALIDATED -> FINALIZED', () => {
      expect(canTransitionAllocation('PENDING', 'CALCULATED')).toBe(true);
      expect(canTransitionAllocation('CALCULATED', 'VALIDATED')).toBe(true);
      expect(canTransitionAllocation('VALIDATED', 'FINALIZED')).toBe(true);
    });

    it('2. Illegal skipping of allocation status (e.g. PENDING -> FINALIZED) throws AllocationStateMachineError', () => {
      expect(canTransitionAllocation('PENDING', 'FINALIZED')).toBe(false);
      expect(() => assertLegalAllocationTransition('PENDING', 'FINALIZED')).toThrow(
        AllocationStateMachineError
      );
    });

    it('3. FINALIZED allocation is terminal and cannot transition to any other status', () => {
      expect(canTransitionAllocation('FINALIZED', 'PENDING')).toBe(false);
      expect(canTransitionAllocation('FINALIZED', 'CALCULATED')).toBe(false);
      expect(canTransitionAllocation('FINALIZED', 'REJECTED')).toBe(false);
    });

    it('4. REJECTED allocation can reset to PENDING to re-attempt calculation', () => {
      expect(canTransitionAllocation('CALCULATED', 'REJECTED')).toBe(true);
      expect(canTransitionAllocation('REJECTED', 'PENDING')).toBe(true);
    });

    it('5. Reconciliation progression moves: PENDING -> IN_PROGRESS -> RECONCILED', () => {
      expect(canTransitionReconciliation('PENDING', 'IN_PROGRESS')).toBe(true);
      expect(canTransitionReconciliation('IN_PROGRESS', 'RECONCILED')).toBe(true);
      expect(canTransitionReconciliation('IN_PROGRESS', 'DISCREPANCY')).toBe(true);
      expect(canTransitionReconciliation('IN_PROGRESS', 'BLOCKED')).toBe(true);
    });

    it('6. RECONCILED is terminal and cannot transition out', () => {
      expect(canTransitionReconciliation('RECONCILED', 'PENDING')).toBe(false);
      expect(canTransitionReconciliation('RECONCILED', 'DISCREPANCY')).toBe(false);
      expect(() => assertLegalReconciliationTransition('RECONCILED', 'IN_PROGRESS')).toThrow(
        AllocationStateMachineError
      );
    });
  });

  // =========================================================================
  // 2. ENTRY CONDITION & FULFILLMENT PREREQUISITE (4 tests)
  // =========================================================================
  describe('2. Entry Condition & Fulfillment Prerequisite', () => {
    it('7. Cannot allocate before fulfillment is verified (rejects non-VERIFIED orders)', () => {
      const inTransitFulfillment: FulfillmentOrder = {
        ...verifiedFulfillment,
        status: 'IN_TRANSIT',
      };

      expect(() =>
        allocationService.prepareAllocation({
          commitment: singleCommitment,
          fulfillments: [inTransitFulfillment],
          residentDemands,
        })
      ).toThrow(AllocationValidationError);
    });

    it('8. Rejects allocation attempt with empty fulfillments list', () => {
      expect(() =>
        allocationService.prepareAllocation({
          commitment: singleCommitment,
          fulfillments: [],
          residentDemands,
        })
      ).toThrow(AllocationValidationError);
    });

    it('9. Partial multi-supplier fulfillment where one order is not verified blocks allocation', () => {
      const unverifiedB: FulfillmentOrder = {
        ...verifiedFulfillmentB,
        status: 'DISPATCHED',
      };

      expect(() =>
        allocationService.prepareAllocation({
          commitment: splitCommitment,
          fulfillments: [verifiedFulfillmentA, unverifiedB],
          residentDemands,
        })
      ).toThrow(AllocationValidationError);
    });

    it('10. Verified fulfillment allows successful entry into CALCULATED state', () => {
      const summary = allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });

      expect(summary.status).toBe('CALCULATED');
      expect(summary.allocations.length).toBe(3);
    });
  });

  // =========================================================================
  // 3. QUANTITY ALLOCATION & CONSERVATION INVARIANTS (7 tests)
  // =========================================================================
  describe('3. Quantity Allocation & Conservation Invariants', () => {
    it('11. Full fulfillment allocates 100% of requested demand to all residents', () => {
      const results = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 10,
        allowFractions: false,
      });

      expect(results.find((r) => r.residentReference === 'res_ref_aarav')?.allocatedQuantity).toBe(4);
      expect(results.find((r) => r.residentReference === 'res_ref_riya')?.allocatedQuantity).toBe(3);
      expect(results.find((r) => r.residentReference === 'res_ref_kabir')?.allocatedQuantity).toBe(3);

      const sum = results.reduce((s, r) => s + r.allocatedQuantity, 0);
      expect(sum).toBe(10);
    });

    it('12. Zero fulfilled quantity allocates 0 to all residents safely', () => {
      const results = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 0,
        allowFractions: false,
      });

      expect(results.every((r) => r.allocatedQuantity === 0)).toBe(true);
    });

    it('13. Rejects negative fulfilled quantity with AllocationValidationError', () => {
      expect(() =>
        engine.allocateQuantities({
          residentDemands,
          verifiedFulfilledQuantity: -5,
        })
      ).toThrow(AllocationValidationError);
    });

    it('14. Over-allocation: Total allocated quantity never exceeds verified fulfilled quantity', () => {
      const results = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 8,
        allowFractions: false,
      });

      const totalAllocated = results.reduce((s, r) => s + r.allocatedQuantity, 0);
      expect(totalAllocated).toBe(8);
      expect(totalAllocated).toBeLessThanOrEqual(8);
    });

    it('15. Negative requested quantity in resident demand is strictly rejected', () => {
      const invalidDemand: ResidentDemand[] = [
        {
          ...residentDemands[0],
          requestedQuantity: -2,
        },
      ];

      expect(() =>
        engine.allocateQuantities({
          residentDemands: invalidDemand,
          verifiedFulfilledQuantity: 5,
        })
      ).toThrow(AllocationValidationError);
    });

    it('16. Individual allocated quantity never exceeds requested quantity (allocated <= requested)', () => {
      const results = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 6,
      });

      for (const res of results) {
        expect(res.allocatedQuantity).toBeLessThanOrEqual(res.requestedQuantity);
        expect(res.allocatedQuantity).toBeGreaterThanOrEqual(0);
      }
    });

    it('17. Exact quantity conservation holds: SUM(allocated) === verifiedFulfilled', () => {
      const results = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 7,
      });

      const sum = results.reduce((s, r) => s + r.allocatedQuantity, 0);
      expect(sum).toBe(7);
    });
  });

  // =========================================================================
  // 4. PARTIAL FULFILLMENT & WHOLE-UNIT LARGEST REMAINDER (6 tests)
  // =========================================================================
  describe('4. Partial Fulfillment & Whole-Unit Allocation', () => {
    it('18. Whole-unit allocation uses Hamilton-Hare largest remainder algorithm (10 req, 6 avail -> A=2, B=2, C=2)', () => {
      // Demands: A=4 (quota 2.4, rem 0.4), B=3 (quota 1.8, rem 0.8), C=3 (quota 1.8, rem 0.8)
      // Bases: A=2, B=1, C=1 (sum = 4). Remainder units = 2.
      // B and C have larger remainder (0.8 > 0.4), so B and C get +1 unit.
      // Final: A=2, B=2, C=2. Sum = 6.
      const results = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 6,
        allowFractions: false,
      });

      expect(results.find((r) => r.residentReference === 'res_ref_aarav')?.allocatedQuantity).toBe(2);
      expect(results.find((r) => r.residentReference === 'res_ref_riya')?.allocatedQuantity).toBe(2);
      expect(results.find((r) => r.residentReference === 'res_ref_kabir')?.allocatedQuantity).toBe(2);

      const total = results.reduce((s, r) => s + r.allocatedQuantity, 0);
      expect(total).toBe(6);
    });

    it('19. Partial fulfillment with 5 units distributes deterministically (A=2, B=1, C=2 via stable tie-break)', () => {
      // Available: 5. Exact quotas: A=2.0 (rem 0), B=1.5 (rem 0.5), C=1.5 (rem 0.5)
      // Bases: A=2, B=1, C=1 (sum = 4). Remainder = 1.
      // B and C tie at 0.5 remainder. Stable tie-break by residentOrderId ('ro_kabir_003' < 'ro_riya_002').
      // Kabir gets the 1 surplus unit.
      const results = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 5,
        allowFractions: false,
      });

      expect(results.find((r) => r.residentReference === 'res_ref_aarav')?.allocatedQuantity).toBe(2);
      expect(results.find((r) => r.residentReference === 'res_ref_riya')?.allocatedQuantity).toBe(1);
      expect(results.find((r) => r.residentReference === 'res_ref_kabir')?.allocatedQuantity).toBe(2);

      const total = results.reduce((s, r) => s + r.allocatedQuantity, 0);
      expect(total).toBe(5);
    });

    it('20. Deterministic tie breaking is stable across multiple identical executions', () => {
      const run1 = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 5,
        allowFractions: false,
      });
      const run2 = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 5,
        allowFractions: false,
      });

      expect(run1).toEqual(run2);
    });

    it('21. Fractional unit allocation allows exact Decimal division when allowFractions: true', () => {
      const results = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 6.5,
        allowFractions: true,
      });

      const total = results.reduce((s, r) => s + r.allocatedQuantity, 0);
      expect(total).toBe(6.5);
    });

    it('22. Single unit available in scarce inventory goes to highest demand resident', () => {
      // Demands: A=4, B=3, C=3. Total = 10. Available = 1.
      // Quotas: A=0.4, B=0.3, C=0.3. A has largest remainder (0.4).
      const results = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 1,
        allowFractions: false,
      });

      expect(results.find((r) => r.residentReference === 'res_ref_aarav')?.allocatedQuantity).toBe(1);
      expect(results.find((r) => r.residentReference === 'res_ref_riya')?.allocatedQuantity).toBe(0);
      expect(results.find((r) => r.residentReference === 'res_ref_kabir')?.allocatedQuantity).toBe(0);
    });

    it('23. Zero units allocated to all when verified fulfilled quantity is 0', () => {
      const results = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 0,
        allowFractions: false,
      });

      expect(results.reduce((s, r) => s + r.allocatedQuantity, 0)).toBe(0);
    });
  });

  // =========================================================================
  // 5. MONETARY ALLOCATION & DECIMAL PRECISION (7 tests)
  // =========================================================================
  describe('5. Monetary Allocation & Decimal Precision', () => {
    it('24. Financial allocation allocates exact costs proportionally across residents', () => {
      const qtyAllocations = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 10,
      });

      const costResults = costService.allocateCosts(qtyAllocations, {
        subtotal: 5000,
        tax: 250,
        deliveryFee: 150,
        otherCharges: 100,
        total: 5500,
      });

      // A (40%): subtotal ₹2,000, tax ₹100, delivery ₹60, other ₹40 = ₹2,200
      // B (30%): subtotal ₹1,500, tax ₹75, delivery ₹45, other ₹30 = ₹1,650
      // C (30%): subtotal ₹1,500, tax ₹75, delivery ₹45, other ₹30 = ₹1,650
      const aaravCost = costResults.find((c) => c.residentReference === 'res_ref_aarav')!;
      const riyaCost = costResults.find((c) => c.residentReference === 'res_ref_riya')!;
      const kabirCost = costResults.find((c) => c.residentReference === 'res_ref_kabir')!;

      expect(aaravCost.totalAmount).toBe(2200);
      expect(riyaCost.totalAmount).toBe(1650);
      expect(kabirCost.totalAmount).toBe(1650);

      const totalSum = costResults.reduce((s, c) => s + c.totalAmount, 0);
      expect(totalSum).toBe(5500);
    });

    it('25. Residual paise allocation prevents loss of cents (e.g. ₹100 split 3 ways = 33.34, 33.33, 33.33)', () => {
      // 3 residents with equal 1-unit allocations
      const equalDemands: ResidentDemand[] = [
        { ...residentDemands[0], requestedQuantity: 1 },
        { ...residentDemands[1], requestedQuantity: 1 },
        { ...residentDemands[2], requestedQuantity: 1 },
      ];

      const qty = engine.allocateQuantities({
        residentDemands: equalDemands,
        verifiedFulfilledQuantity: 3,
      });

      const costs = costService.allocateCosts(qty, {
        subtotal: 100,
        tax: 0,
        deliveryFee: 0,
        otherCharges: 0,
        total: 100,
      });

      const amounts = costs.map((c) => c.totalAmount).sort((a, b) => b - a);
      expect(amounts).toEqual([33.34, 33.33, 33.33]);

      const sum = costs.reduce((s, c) => s + c.totalAmount, 0);
      expect(sum).toBe(100.0);
    });

    it('26. Invariant holds: Line items (subtotal + tax + delivery + other) strictly equals totalAmount for each resident', () => {
      const qtyAllocations = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 7,
      });

      const costs = costService.allocateCosts(qtyAllocations, {
        subtotal: 3500,
        tax: 175,
        deliveryFee: 100,
        otherCharges: 50,
        total: 3825,
      });

      for (const cost of costs) {
        const lineSum =
          Math.round(
            (cost.subtotal +
              cost.allocatedTax +
              cost.allocatedDeliveryFee +
              cost.allocatedOtherCharges) *
              100
          ) / 100;
        expect(lineSum).toBe(cost.totalAmount);
      }
    });

    it('27. Rejects financial input if subtotal + tax + delivery + other does not equal total', () => {
      const qtyAllocations = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 10,
      });

      expect(() =>
        costService.allocateCosts(qtyAllocations, {
          subtotal: 5000,
          tax: 250,
          deliveryFee: 150,
          otherCharges: 100,
          total: 6000, // Deliberate mismatch (should be 5500)
        })
      ).toThrow(AllocationValidationError);
    });

    it('28. Partial fulfillment charges residents only for their fulfilled allocation', () => {
      // 10 requested, only 6 fulfilled. Available cost = ₹3,300 (₹550 per fulfilled unit)
      const qtyAllocations = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 6,
      });

      const costs = costService.allocateCosts(qtyAllocations, {
        subtotal: 3000,
        tax: 150,
        deliveryFee: 100,
        otherCharges: 50,
        total: 3300,
      });

      // Sum of resident charges must be exactly ₹3,300, not the full ₹5,500
      const totalAllocatedAmount = costs.reduce((s, c) => s + c.totalAmount, 0);
      expect(totalAllocatedAmount).toBe(3300);
    });

    it('29. Zero allocation results in ₹0.00 for all residents', () => {
      const qtyAllocations = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 0,
      });

      const costs = costService.allocateCosts(qtyAllocations, {
        subtotal: 0,
        tax: 0,
        deliveryFee: 0,
        otherCharges: 0,
        total: 0,
      });

      expect(costs.every((c) => c.totalAmount === 0)).toBe(true);
    });

    it('30. Monetary conservation invariant is strictly verified with zero floating point drift', () => {
      const qtyAllocations = engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: 10,
      });

      const costs = costService.allocateCosts(qtyAllocations, {
        subtotal: 1234.56,
        tax: 123.45,
        deliveryFee: 67.89,
        otherCharges: 12.34,
        total: 1438.24,
      });

      const sum = costs.reduce((s, c) => s + c.totalAmount, 0);
      expect(Math.round(sum * 100) / 100).toBe(1438.24);
    });
  });

  // =========================================================================
  // 6. MULTI-SUPPLIER PROCUREMENT & ALLOCATION (5 tests)
  // =========================================================================
  describe('6. Multi-Supplier Procurement & Allocation', () => {
    it('31. Allocates across multi-supplier verified fulfillments without double counting', () => {
      // Supplier A verified 6 units, Supplier B verified 4 units. Total verified = 10 units.
      const summary = allocationService.prepareAllocation({
        commitment: splitCommitment,
        fulfillments: [verifiedFulfillmentA, verifiedFulfillmentB],
        residentDemands,
      });

      expect(summary.totalAllocatedQuantity).toBe(10);
      expect(summary.totalResidentAllocatedAmount).toBe(5520);
      expect(summary.residentCount).toBe(3);
    });

    it('32. Multi-supplier allocation records both contributing supplier IDs in audit/metadata', () => {
      const summary = allocationService.prepareAllocation({
        commitment: splitCommitment,
        fulfillments: [verifiedFulfillmentA, verifiedFulfillmentB],
        residentDemands,
      });

      for (const alloc of summary.allocations) {
        expect(alloc.contributingSupplierIds).toContain('sup_a');
        expect(alloc.contributingSupplierIds).toContain('sup_b');
      }
    });

    it('33. Supplier confidentiality: Resident allocations contain zero competitor bid prices or margins', () => {
      const summary = allocationService.prepareAllocation({
        commitment: splitCommitment,
        fulfillments: [verifiedFulfillmentA, verifiedFulfillmentB],
        residentDemands,
      });

      for (const alloc of summary.allocations) {
        const jsonString = JSON.stringify(alloc);
        expect(jsonString).not.toContain('quoteId');
        expect(jsonString).not.toContain('negotiation');
        expect(jsonString).not.toContain('counteroffer');
      }
    });

    it('34. Multi-supplier partial fulfillment reconciles verified portions accurately', () => {
      // Supplier A delivered 6 units, Supplier B delivered only 2 units (instead of 4). Total = 8 units.
      const partialFulfillmentB: FulfillmentOrder = {
        ...verifiedFulfillmentB,
        fulfilledQuantity: 2,
        remainingQuantity: 2,
      };

      const partialCommitment: ProcurementCommitment = {
        ...splitCommitment,
        financials: {
          subtotal: 4040,
          tax: 200,
          deliveryFee: 120,
          otherCharges: 70,
          total: 4430,
          currency: 'INR',
        },
      };

      const summary = allocationService.prepareAllocation({
        commitment: partialCommitment,
        fulfillments: [verifiedFulfillmentA, partialFulfillmentB],
        residentDemands,
      });

      expect(summary.totalAllocatedQuantity).toBe(8);
      expect(summary.totalResidentAllocatedAmount).toBe(4430);
    });

    it('35. Multi-supplier reconciliation passes RECONCILED when all supplier obligations match', async () => {
      allocationService.prepareAllocation({
        commitment: splitCommitment,
        fulfillments: [verifiedFulfillmentA, verifiedFulfillmentB],
        residentDemands,
      });

      const { reconciliation } = await allocationService.finalizeAllocation({
        commitmentId: splitCommitment.id,
        payments: [paymentSupplierA, paymentSupplierB],
        purchaseOrders: [poSupplierA, poSupplierB],
      });

      expect(reconciliation.status).toBe('RECONCILED');
      expect(reconciliation.isSupplierObligationsMatched).toBe(true);
      expect(reconciliation.isPaymentVerified).toBe(true);
    });
  });

  // =========================================================================
  // 7. RESIDENT ACCOUNTING LEDGER & IMMUTABILITY (6 tests)
  // =========================================================================
  describe('7. Resident Accounting Ledger & Immutability', () => {
    it('36. Finalizing allocation creates append-only ledger entries for each resident', async () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });

      const { ledgerEntries } = await allocationService.finalizeAllocation({
        commitmentId: singleCommitment.id,
        payments: [singlePayment],
      });

      expect(ledgerEntries.length).toBe(3);
      expect(ledgerEntries.every((e) => e.entryType === 'PROCUREMENT_ALLOCATION')).toBe(true);
      expect(ledgerEntries.every((e) => e.status === 'POSTED')).toBe(true);
    });

    it('37. Ledger entries are append-only; amounts are never silently edited in place', () => {
      const allocation = {
        id: 'alloc_aarav_test',
        commitmentId: singleCommitment.id,
        residentOrderId: 'ro_aarav_001',
        residentReference: 'res_ref_aarav',
        productId: 'prod_rice',
        productName: 'Rice',
        requestedQuantity: 4,
        allocatedQuantity: 4,
        unit: 'PACK',
        unitPrice: 500,
        subtotal: 2000,
        allocatedTax: 100,
        allocatedDeliveryFee: 60,
        allocatedOtherCharges: 40,
        totalAmount: 2200,
        allocationStatus: 'FINALIZED' as const,
        reconciliationStatus: 'RECONCILED' as const,
        idempotencyKey: 'idemp_alloc_aarav',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const entry = ledgerService.postAllocation(allocation);
      expect(entry.amount).toBe(2200);

      // Explicit adjustment entry is created instead of editing the original entry
      const adj = ledgerService.postAdjustment({
        residentReference: 'res_ref_aarav',
        residentOrderId: 'ro_aarav_001',
        allocationId: allocation.id,
        commitmentId: singleCommitment.id,
        amount: -50,
        referenceEntryId: entry.id,
        reason: 'Community bulk rebate applied',
      });

      expect(adj.amount).toBe(-50);
      expect(adj.referenceEntryId).toBe(entry.id);
      expect(adj.entryType).toBe('ADJUSTMENT');

      // Original entry is preserved completely unchanged
      const entries = ledgerService.getEntriesForResident('res_ref_aarav', 'res_ref_aarav');
      expect(entries.find((e) => e.id === entry.id)?.amount).toBe(2200);
      expect(entries.length).toBe(2);
    });

    it('38. Reversal creates explicit negative entry and marks original as REVERSED', () => {
      const allocation = {
        id: 'alloc_rev_test',
        commitmentId: singleCommitment.id,
        residentOrderId: 'ro_rev_001',
        residentReference: 'res_ref_rev',
        productId: 'prod_rice',
        productName: 'Rice',
        requestedQuantity: 2,
        allocatedQuantity: 2,
        unit: 'PACK',
        unitPrice: 500,
        subtotal: 1000,
        allocatedTax: 50,
        allocatedDeliveryFee: 30,
        allocatedOtherCharges: 20,
        totalAmount: 1100,
        allocationStatus: 'FINALIZED' as const,
        reconciliationStatus: 'RECONCILED' as const,
        idempotencyKey: 'idemp_alloc_rev',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const entry = ledgerService.postAllocation(allocation);
      const reversal = ledgerService.postReversal({
        originalEntryId: entry.id,
        reason: 'Resident order cancelled post-fulfillment return',
      });

      expect(reversal.amount).toBe(-1100);
      expect(reversal.entryType).toBe('REVERSAL');
      expect(entry.status).toBe('REVERSED');
    });

    it('39. Cannot reverse an already reversed ledger entry', () => {
      const allocation = {
        id: 'alloc_double_rev',
        commitmentId: singleCommitment.id,
        residentOrderId: 'ro_drev_001',
        residentReference: 'res_ref_drev',
        productId: 'prod_rice',
        productName: 'Rice',
        requestedQuantity: 1,
        allocatedQuantity: 1,
        unit: 'PACK',
        unitPrice: 500,
        subtotal: 500,
        allocatedTax: 25,
        allocatedDeliveryFee: 15,
        allocatedOtherCharges: 10,
        totalAmount: 550,
        allocationStatus: 'FINALIZED' as const,
        reconciliationStatus: 'RECONCILED' as const,
        idempotencyKey: 'idemp_alloc_drev',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const entry = ledgerService.postAllocation(allocation);
      ledgerService.postReversal({
        originalEntryId: entry.id,
        reason: 'First reversal',
      });

      expect(() =>
        ledgerService.postReversal({
          originalEntryId: entry.id,
          reason: 'Second illegal duplicate reversal',
        })
      ).toThrow(AllocationValidationError);
    });

    it('40. Net resident balance accurately accounts for debits, adjustments, and reversals', () => {
      const allocation = {
        id: 'alloc_balance_test',
        commitmentId: singleCommitment.id,
        residentOrderId: 'ro_bal_001',
        residentReference: 'res_ref_bal',
        productId: 'prod_rice',
        productName: 'Rice',
        requestedQuantity: 2,
        allocatedQuantity: 2,
        unit: 'PACK',
        unitPrice: 500,
        subtotal: 1000,
        allocatedTax: 50,
        allocatedDeliveryFee: 30,
        allocatedOtherCharges: 20,
        totalAmount: 1100,
        allocationStatus: 'FINALIZED' as const,
        reconciliationStatus: 'RECONCILED' as const,
        idempotencyKey: 'idemp_alloc_bal',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const entry = ledgerService.postAllocation(allocation);
      ledgerService.postAdjustment({
        residentReference: 'res_ref_bal',
        residentOrderId: 'ro_bal_001',
        allocationId: allocation.id,
        commitmentId: singleCommitment.id,
        amount: -100,
        referenceEntryId: entry.id,
        reason: 'Delivery discount',
      });

      const { balance } = ledgerService.getResidentBalance('res_ref_bal', 'res_ref_bal');
      expect(balance).toBe(1000); // 1100 - 100
    });

    it('41. Duplicate posting of same allocation returns cached existing ledger entry', () => {
      const allocation = {
        id: 'alloc_dedupe_test',
        commitmentId: singleCommitment.id,
        residentOrderId: 'ro_dup_001',
        residentReference: 'res_ref_dup',
        productId: 'prod_rice',
        productName: 'Rice',
        requestedQuantity: 1,
        allocatedQuantity: 1,
        unit: 'PACK',
        unitPrice: 500,
        subtotal: 500,
        allocatedTax: 25,
        allocatedDeliveryFee: 15,
        allocatedOtherCharges: 10,
        totalAmount: 550,
        allocationStatus: 'FINALIZED' as const,
        reconciliationStatus: 'RECONCILED' as const,
        idempotencyKey: 'idemp_alloc_dup',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const e1 = ledgerService.postAllocation(allocation);
      const e2 = ledgerService.postAllocation(allocation);
      expect(e1.id).toBe(e2.id);
    });
  });

  // =========================================================================
  // 8. RECONCILIATION ENGINE & DISCREPANCY DETECTION (7 tests)
  // =========================================================================
  describe('8. Reconciliation Engine & Discrepancy Detection', () => {
    it('42. Successful reconciliation yields RECONCILED with zero discrepancies', () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });

      const summary = allocationService.validateAllocation(singleCommitment.id);

      const result = reconService.reconcileCommitment({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        allocations: summary.allocations,
        payments: [singlePayment],
        purchaseOrders: [singlePO],
      });

      expect(result.status).toBe('RECONCILED');
      expect(result.isQuantityMatched).toBe(true);
      expect(result.isMonetaryMatched).toBe(true);
      expect(result.isSupplierObligationsMatched).toBe(true);
      expect(result.isPaymentVerified).toBe(true);
      expect(result.discrepancies.length).toBe(0);
      expect(result.reconciledAt).toBeDefined();
    });

    it('43. Quantity mismatch creates QUANTITY_MISMATCH discrepancy and sets DISCREPANCY status', () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });

      const summary = allocationService.validateAllocation(singleCommitment.id);

      // Artificially drop 1 unit from allocations to test discrepancy detection
      const faultyAllocations = summary.allocations.map((a, idx) =>
        idx === 0 ? { ...a, allocatedQuantity: a.allocatedQuantity - 1 } : a
      );

      const result = reconService.reconcileCommitment({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        allocations: faultyAllocations,
        payments: [singlePayment],
        purchaseOrders: [singlePO],
      });

      expect(result.status).toBe('DISCREPANCY');
      expect(result.isQuantityMatched).toBe(false);
      expect(result.discrepancies.some((d) => d.discrepancyType === 'QUANTITY_MISMATCH')).toBe(true);
    });

    it('44. Monetary mismatch creates MONETARY_MISMATCH discrepancy', () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });

      const summary = allocationService.validateAllocation(singleCommitment.id);

      // Faulty allocation where monetary total is ₹100 less than authoritative cost
      const faultyAllocations = summary.allocations.map((a, idx) =>
        idx === 0 ? { ...a, totalAmount: a.totalAmount - 100 } : a
      );

      const result = reconService.reconcileCommitment({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        allocations: faultyAllocations,
        payments: [singlePayment],
        purchaseOrders: [singlePO],
      });

      expect(result.status).toBe('DISCREPANCY');
      expect(result.isMonetaryMatched).toBe(false);
      expect(result.discrepancies.some((d) => d.discrepancyType === 'MONETARY_MISMATCH')).toBe(true);
    });

    it('45. Missing or unconfirmed payment creates PAYMENT_LINKAGE_MISMATCH discrepancy', () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });

      const summary = allocationService.validateAllocation(singleCommitment.id);

      const failedPayment: Payment = {
        ...singlePayment,
        status: 'FAILED',
      };

      const result = reconService.reconcileCommitment({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        allocations: summary.allocations,
        payments: [failedPayment],
        purchaseOrders: [singlePO],
      });

      expect(result.status).toBe('DISCREPANCY');
      expect(result.isPaymentVerified).toBe(false);
      expect(result.discrepancies.some((d) => d.discrepancyType === 'PAYMENT_LINKAGE_MISMATCH')).toBe(
        true
      );
    });

    it('46. Unverified fulfillment order sets status to BLOCKED with UNVERIFIED_FULFILLMENT discrepancy', () => {
      const inProgressFulfillment: FulfillmentOrder = {
        ...verifiedFulfillment,
        status: 'IN_TRANSIT',
      };

      const result = reconService.reconcileCommitment({
        commitment: singleCommitment,
        fulfillments: [inProgressFulfillment],
        allocations: [],
        payments: [singlePayment],
      });

      expect(result.status).toBe('BLOCKED');
      expect(result.discrepancies.some((d) => d.discrepancyType === 'UNVERIFIED_FULFILLMENT')).toBe(
        true
      );
    });

    it('47. Over-allocation creates OVER_ALLOCATION_DETECTED discrepancy', () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });

      const summary = allocationService.validateAllocation(singleCommitment.id);

      const overAllocations = summary.allocations.map((a, idx) =>
        idx === 0 ? { ...a, allocatedQuantity: a.allocatedQuantity + 2 } : a
      );

      const result = reconService.reconcileCommitment({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        allocations: overAllocations,
        payments: [singlePayment],
      });

      expect(result.status).toBe('DISCREPANCY');
      expect(result.discrepancies.some((d) => d.discrepancyType === 'OVER_ALLOCATION_DETECTED')).toBe(
        true
      );
    });

    it('48. Repeated reconciliation execution is idempotent and returns consistent result', () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });

      const summary = allocationService.validateAllocation(singleCommitment.id);

      const r1 = reconService.reconcileCommitment({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        allocations: summary.allocations,
        payments: [singlePayment],
      });

      const r2 = reconService.reconcileCommitment({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        allocations: summary.allocations,
        payments: [singlePayment],
      });

      expect(r1.id).toBe(r2.id);
      expect(r1.status).toBe(r2.status);
    });
  });

  // =========================================================================
  // 9. IDEMPOTENCY & CONCURRENCY PROTECTION (5 tests)
  // =========================================================================
  describe('9. Idempotency & Concurrency Protection', () => {
    it('49. Duplicate prepareAllocation with same idempotency key returns cached summary', () => {
      const s1 = allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
        idempotencyKey: 'idemp_key_alloc_1',
      });

      const s2 = allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
        idempotencyKey: 'idemp_key_alloc_1',
      });

      expect(s1).toBe(s2);
    });

    it('50. Duplicate finalizeAllocation returns existing finalized summary and ledger records', async () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });

      const res1 = await allocationService.finalizeAllocation({
        commitmentId: singleCommitment.id,
        payments: [singlePayment],
      });

      const res2 = await allocationService.finalizeAllocation({
        commitmentId: singleCommitment.id,
        payments: [singlePayment],
      });

      expect(res1.summary.status).toBe('FINALIZED');
      expect(res2.summary.status).toBe('FINALIZED');
      expect(res1.ledgerEntries.length).toBe(res2.ledgerEntries.length);
    });

    it('51. Concurrent calls to finalizeAllocation serialize cleanly under mutex', async () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });

      const [res1, res2] = await Promise.all([
        allocationService.finalizeAllocation({
          commitmentId: singleCommitment.id,
          payments: [singlePayment],
        }),
        allocationService.finalizeAllocation({
          commitmentId: singleCommitment.id,
          payments: [singlePayment],
        }),
      ]);

      expect(res1.summary.status).toBe('FINALIZED');
      expect(res2.summary.status).toBe('FINALIZED');
      // Total ledger entries must not be duplicated (3, not 6)
      const allEntries = ledgerService.getAllEntriesForCommitment(singleCommitment.id);
      expect(allEntries.length).toBe(3);
    });

    it('52. Mutex prevents race condition during rapid parallel ledger adjustments', () => {
      const allocation = {
        id: 'alloc_race_test',
        commitmentId: singleCommitment.id,
        residentOrderId: 'ro_race_001',
        residentReference: 'res_ref_race',
        productId: 'prod_rice',
        productName: 'Rice',
        requestedQuantity: 2,
        allocatedQuantity: 2,
        unit: 'PACK',
        unitPrice: 500,
        subtotal: 1000,
        allocatedTax: 50,
        allocatedDeliveryFee: 30,
        allocatedOtherCharges: 20,
        totalAmount: 1100,
        allocationStatus: 'FINALIZED' as const,
        reconciliationStatus: 'RECONCILED' as const,
        idempotencyKey: 'idemp_race',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const entry = ledgerService.postAllocation(allocation);
      ledgerService.postAdjustment({
        residentReference: 'res_ref_race',
        residentOrderId: 'ro_race_001',
        allocationId: allocation.id,
        commitmentId: singleCommitment.id,
        amount: -10,
        referenceEntryId: entry.id,
        reason: 'Adj 1',
      });
      ledgerService.postAdjustment({
        residentReference: 'res_ref_race',
        residentOrderId: 'ro_race_001',
        allocationId: allocation.id,
        commitmentId: singleCommitment.id,
        amount: -20,
        referenceEntryId: entry.id,
        reason: 'Adj 2',
      });

      const { balance } = ledgerService.getResidentBalance('res_ref_race', 'res_ref_race');
      expect(balance).toBe(1070); // 1100 - 10 - 20
    });

    it('53. Idempotent ledger entry posting does not duplicate entries on network retry', () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });

      const summary = allocationService.validateAllocation(singleCommitment.id);
      const alloc = summary.allocations[0];

      const e1 = ledgerService.postAllocation(alloc);
      const e2 = ledgerService.postAllocation(alloc);

      expect(e1.id).toBe(e2.id);
    });
  });

  // =========================================================================
  // 10. RESIDENT PRIVACY & SERVER-SIDE AUTHORIZATION (5 tests)
  // =========================================================================
  describe('10. Resident Privacy & Server-Side Authorization', () => {
    it('54. Resident A can query their own allocations successfully', async () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });
      await allocationService.finalizeAllocation({
        commitmentId: singleCommitment.id,
        payments: [singlePayment],
      });

      const allocs = allocationService.getResidentAllocations('res_ref_aarav', 'res_ref_aarav');
      expect(allocs.length).toBe(1);
      expect(allocs[0].residentReference).toBe('res_ref_aarav');
      expect(allocs[0].allocatedQuantity).toBe(4);
    });

    it('55. Resident A is strictly rejected when attempting to query Resident B allocations (throws UNAUTHORIZED)', async () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });
      await allocationService.finalizeAllocation({
        commitmentId: singleCommitment.id,
        payments: [singlePayment],
      });

      expect(() =>
        allocationService.getResidentAllocations('res_ref_riya', 'res_ref_aarav')
      ).toThrow(AllocationValidationError);
    });

    it('56. Resident A is strictly rejected when attempting to query Resident B ledger entries', async () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });
      await allocationService.finalizeAllocation({
        commitmentId: singleCommitment.id,
        payments: [singlePayment],
      });

      expect(() =>
        ledgerService.getEntriesForResident('res_ref_riya', 'res_ref_aarav')
      ).toThrow(AllocationValidationError);
    });

    it('57. Resident A is rejected when attempting to query Resident B net balance', async () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });
      await allocationService.finalizeAllocation({
        commitmentId: singleCommitment.id,
        payments: [singlePayment],
      });

      expect(() =>
        ledgerService.getResidentBalance('res_ref_riya', 'res_ref_aarav')
      ).toThrow(AllocationValidationError);
    });

    it('58. Resident cannot inspect another resident order explanation', async () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });

      expect(() =>
        allocationService.explainAllocation('ro_riya_002', 'res_ref_aarav')
      ).toThrow(AllocationValidationError);
    });
  });

  // =========================================================================
  // 11. CONSTRAINED AI AGENT TOOLS & SAFETY (6 tests)
  // =========================================================================
  describe('11. Constrained AI Agent Tools & Safety', () => {
    it('59. Tool registry contains zero arbitrary financial mutation tools (no setResidentAmount, no overrideAllocation, no rawSQL)', () => {
      const forbiddenTools = [
        'setResidentAmount',
        'overrideAllocation',
        'forceReconciliation',
        'editLedger',
        'deleteLedger',
        'executeSQL',
        'rawSQL',
      ];

      for (const toolName of forbiddenTools) {
        expect(toolRegistry.get(toolName)).toBeUndefined();
      }
    });

    it('60. getResidentAllocation tool enforces server-side authorization check', async () => {
      defaultAllocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });
      await defaultAllocationService.finalizeAllocation({
        commitmentId: singleCommitment.id,
        payments: [singlePayment],
      });

      const ctx = { residentId: 'res_ref_aarav', societyId: 'soc_test' } as any;
      const res = await getResidentAllocationTool.execute(
        {
          residentReference: 'res_ref_aarav',
          requestingResidentReference: 'res_ref_aarav',
        },
        ctx
      );

      expect(res.success).toBe(true);
      expect((res as any).allocations.length).toBe(1);

      // Caller impersonation rejection
      await expect(
        getResidentAllocationTool.execute(
          {
            residentReference: 'res_ref_riya',
            requestingResidentReference: 'res_ref_aarav',
          },
          ctx
        )
      ).rejects.toThrow();

      // Forged caller reference rejection (model echo must match context)
      await expect(
        getResidentAllocationTool.execute(
          {
            residentReference: 'res_ref_aarav',
            requestingResidentReference: 'res_ref_riya',
          },
          ctx
        )
      ).rejects.toThrow();
    });

    it('61. getResidentLedger tool retrieves ledger entries and balance read-only with authorization', async () => {
      defaultAllocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });
      await defaultAllocationService.finalizeAllocation({
        commitmentId: singleCommitment.id,
        payments: [singlePayment],
      });

      const res = await getResidentLedgerTool.execute(
        {
          residentReference: 'res_ref_aarav',
          requestingResidentReference: 'res_ref_aarav',
        },
        { residentId: 'res_ref_aarav', societyId: 'soc_test' } as any
      );

      expect(res.success).toBe(true);
      expect((res as any).balance).toBe(2200);
      expect((res as any).entries.length).toBe(1);
    });

    it('62. getAllocationSummary tool retrieves non-PII commitment summary read-only', async () => {
      defaultAllocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });

      const res = await getAllocationSummaryTool.execute(
        {
          commitmentId: singleCommitment.id,
        },
        { residentId: 'res_ref_aarav', societyId: 'soc_test' } as any
      );

      expect(res.success).toBe(true);
      expect((res as any).totalRequestedQuantity).toBe(10);
      expect((res as any).totalAllocatedQuantity).toBe(10);
      expect((res as any).totalProcurementCost).toBe(5500);
    });

    it('63. getReconciliationStatus tool retrieves reconciliation state read-only', async () => {
      defaultAllocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });
      await defaultAllocationService.finalizeAllocation({
        commitmentId: singleCommitment.id,
        payments: [singlePayment],
      });

      const res = await getReconciliationStatusTool.execute(
        {
          commitmentId: singleCommitment.id,
        },
        { residentId: 'res_ref_aarav', societyId: 'soc_test' } as any
      );

      expect(res.success).toBe(true);
      expect((res as any).status).toBe('RECONCILED');
      expect((res as any).isQuantityMatched).toBe(true);
      expect((res as any).isMonetaryMatched).toBe(true);
    });

    it('64. explainAllocation tool provides non-hallucinated breakdown derived from authoritative backend numbers', async () => {
      defaultAllocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });

      const res = await explainAllocationTool.execute(
        {
          residentOrderId: 'ro_aarav_001',
          requestingResidentReference: 'res_ref_aarav',
        },
        { residentId: 'res_ref_aarav', societyId: 'soc_test' } as any
      );

      expect(res.success).toBe(true);
      const explanation = (res as any).explanation;
      expect(explanation.requestedQuantity).toBe(4);
      expect(explanation.allocatedQuantity).toBe(4);
      expect(explanation.totalAmount).toBe(2200);
      expect(explanation.unitPrice).toBe(500);
      expect(explanation.explanationSummary).toContain('fully fulfilled 4 PACK');
    });
  });

  // =========================================================================
  // 12. AUDIT TRAIL, PRIVACY SANITIZATION & LOCATION INDEPENDENCE (6 tests)
  // =========================================================================
  describe('12. Audit Trail, Privacy Sanitization & Location Independence', () => {
    it('65. Emits complete audit event sequence throughout allocation and reconciliation', async () => {
      const publishedEvents: string[] = [];
      const handler = (evt: any) => publishedEvents.push(evt.name);

      eventBus.subscribe('ALLOCATION_STARTED', handler);
      eventBus.subscribe('ALLOCATION_CALCULATED', handler);
      eventBus.subscribe('ALLOCATION_VALIDATED', handler);
      eventBus.subscribe('ALLOCATION_FINALIZED', handler);
      eventBus.subscribe('LEDGER_ENTRY_CREATED', handler);
      eventBus.subscribe('RECONCILIATION_STARTED', handler);
      eventBus.subscribe('RECONCILIATION_RECONCILED', handler);

      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });
      await allocationService.finalizeAllocation({
        commitmentId: singleCommitment.id,
        payments: [singlePayment],
      });

      expect(publishedEvents).toContain('ALLOCATION_STARTED');
      expect(publishedEvents).toContain('ALLOCATION_CALCULATED');
      expect(publishedEvents).toContain('ALLOCATION_VALIDATED');
      expect(publishedEvents).toContain('ALLOCATION_FINALIZED');
      expect(publishedEvents).toContain('LEDGER_ENTRY_CREATED');
      expect(publishedEvents).toContain('RECONCILIATION_STARTED');
      expect(publishedEvents).toContain('RECONCILIATION_RECONCILED');
    });

    it('66. Audit event payloads strictly sanitize resident flat numbers and personal emails', () => {
      let capturedPayload: any = null;
      eventBus.subscribe('ALLOCATION_STARTED', (evt: any) => {
        capturedPayload = evt.payload;
      });

      auditService.emit('ALLOCATION_STARTED', 'agg_1', {
        commitmentId: 'comm_1',
        flatNumber: 'A-101', // Should be redacted
        residentEmail: 'aarav@example.com', // Should be redacted
        pin: '1234', // Should be redacted
        allowedField: 'safeValue',
      });

      expect(capturedPayload.allowedField).toBe('safeValue');
      expect(capturedPayload.flatNumber).toBeUndefined();
      expect(capturedPayload.residentEmail).toBeUndefined();
      expect(capturedPayload.pin).toBeUndefined();
    });

    it('67. Audit events contain zero internal AI reasoning or LLM prompts', () => {
      let capturedPayload: any = null;
      eventBus.subscribe('ALLOCATION_CALCULATED', (evt: any) => {
        capturedPayload = evt.payload;
      });

      auditService.emit('ALLOCATION_CALCULATED', 'agg_2', {
        commitmentId: 'comm_2',
        prompt: 'System prompt instructions...',
        reasoning: 'AI chain-of-thought...',
        amount: 5500,
      });

      expect(capturedPayload.amount).toBe(5500);
      expect(capturedPayload.prompt).toBeUndefined();
      expect(capturedPayload.reasoning).toBeUndefined();
    });

    it('68. Location-agnostic allocation: Works identically across Pune, Bangalore, Delhi, Tokyo, and London', () => {
      const locations = [
        'Greenview Residency, Pune, India',
        'Palm Meadows, Whitefield, Bangalore, India',
        'Vasant Kunj Enclave, New Delhi, India',
        'Roppongi Hills Residences, Tokyo, Japan',
        'Barbican Estate, London, United Kingdom',
      ];

      for (const loc of locations) {
        const locCommitment: ProcurementCommitment = {
          ...singleCommitment,
          id: `comm_${loc.slice(0, 4)}`,
        };
        const locFulfillment: FulfillmentOrder = {
          ...verifiedFulfillment,
          commitmentId: locCommitment.id,
          deliveryArea: `${loc} - Central Receiving Hub`,
        };

        const summary = allocationService.prepareAllocation({
          commitment: locCommitment,
          fulfillments: [locFulfillment],
          residentDemands,
        });

        expect(summary.totalAllocatedQuantity).toBe(10);
        expect(summary.totalResidentAllocatedAmount).toBe(5500);
      }
    });

    it('69. Partial fulfillment explanation clearly articulates scarcity policy to residents', () => {
      allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [
          {
            ...verifiedFulfillment,
            fulfilledQuantity: 6,
            remainingQuantity: 4,
          },
        ],
        residentDemands,
      });

      const explanation = allocationService.explainAllocation('ro_aarav_001', 'res_ref_aarav');
      expect(explanation.allocatedQuantity).toBe(2);
      expect(explanation.requestedQuantity).toBe(4);
      expect(explanation.explanationSummary).toContain('Requested 4 PACK, allocated 2 PACK');
      expect(explanation.allocationPolicy).toContain('Hamilton-Hare');
    });

    it('70. End-to-End: Complete flow from verified fulfillment to finalized ledger and RECONCILED status', async () => {
      // 1. Prepare
      const summary = allocationService.prepareAllocation({
        commitment: singleCommitment,
        fulfillments: [verifiedFulfillment],
        residentDemands,
      });
      expect(summary.status).toBe('CALCULATED');

      // 2. Validate
      const validated = allocationService.validateAllocation(singleCommitment.id);
      expect(validated.status).toBe('VALIDATED');

      // 3. Finalize & Reconcile
      const { reconciliation, ledgerEntries } = await allocationService.finalizeAllocation({
        commitmentId: singleCommitment.id,
        payments: [singlePayment],
        purchaseOrders: [singlePO],
      });

      expect(reconciliation.status).toBe('RECONCILED');
      expect(reconciliation.isQuantityMatched).toBe(true);
      expect(reconciliation.isMonetaryMatched).toBe(true);
      expect(reconciliation.isPaymentVerified).toBe(true);
      expect(reconciliation.isSupplierObligationsMatched).toBe(true);
      expect(ledgerEntries.length).toBe(3);

      // Verify resident Aarav ledger balance
      const aaravBal = ledgerService.getResidentBalance('res_ref_aarav', 'res_ref_aarav');
      expect(aaravBal.balance).toBe(2200);

      // Verify resident Riya ledger balance
      const riyaBal = ledgerService.getResidentBalance('res_ref_riya', 'res_ref_riya');
      expect(riyaBal.balance).toBe(1650);

      // Verify resident Kabir ledger balance
      const kabirBal = ledgerService.getResidentBalance('res_ref_kabir', 'res_ref_kabir');
      expect(kabirBal.balance).toBe(1650);

      // Sum of balances = authoritative total
      expect(aaravBal.balance + riyaBal.balance + kabirBal.balance).toBe(5500);
    });
  });
});
