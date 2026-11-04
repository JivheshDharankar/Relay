import { describe, it, expect } from 'vitest';
import { QuoteSelectionComparator } from '../src/discovery/supplier/selection/QuoteSelectionComparator';
import { SelectionAIAdvisor } from '../src/discovery/supplier/selection/SelectionAIAdvisor';
import { PurchaseOrderService } from '../src/discovery/supplier/selection/PurchaseOrderService';
import { ReconciliationService } from '../src/allocation/ReconciliationService';
import { RFQ } from '../src/discovery/supplier/rfq/types';
import { Quote } from '../src/discovery/supplier/quote/types';
import { ProcurementCommitment, SupplierAllocation } from '../src/discovery/supplier/selection/types';
import { ResidentAllocation } from '../src/allocation/types';
import { FulfillmentOrder } from '../src/fulfillment/types';
import { Payment } from '../src/payment/types';

describe('Data Consistency Phase 2: Multi-Item Quantities & Per-Line Reconciliation', () => {
  const comparator = new QuoteSelectionComparator();
  const advisor = new SelectionAIAdvisor();
  const poService = new PurchaseOrderService();
  const reconService = new ReconciliationService();

  const multiItemRFQ: RFQ = {
    id: 'rfq_multi_123',
    candidateId: 'cand_alpha',
    supplierName: 'Alpha Supermarket',
    recipientContact: 'alpha@market.com',
    deliveryArea: 'Greenview Residency, Pune',
    deliveryDeadline: new Date(Date.now() + 24 * 3600 * 1000),
    quoteDeadline: new Date(Date.now() + 6 * 3600 * 1000),
    status: 'SENT',
    lineItems: [
      {
        productId: '44444444-4444-4444-8444-444444444401',
        productName: 'Rice (Sona Masoori)',
        quantity: 2,
        unit: 'kg',
      },
      {
        productId: '44444444-4444-4444-8444-444444444402',
        productName: 'Sugar (Refined)',
        quantity: 1,
        unit: 'kg',
      },
      {
        productId: '44444444-4444-4444-8444-444444444416',
        productName: 'Maggi 2-Minute Noodles',
        quantity: 2,
        unit: 'pack',
      },
    ],
    terms: 'Net 30',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const fullQuote: Quote = {
    id: 'quote_full',
    rfqId: 'rfq_multi_123',
    candidateId: 'cand_alpha',
    supplierName: 'Alpha Supermarket',
    lineItems: [
      {
        productId: '44444444-4444-4444-8444-444444444401',
        productName: 'Rice (Sona Masoori)',
        quotedQuantity: 2,
        unit: 'kg',
        unitPrice: 80,
      },
      {
        productId: '44444444-4444-4444-8444-444444444402',
        productName: 'Sugar (Refined)',
        quotedQuantity: 1,
        unit: 'kg',
        unitPrice: 45,
      },
      {
        productId: '44444444-4444-4444-8444-444444444416',
        productName: 'Maggi 2-Minute Noodles',
        quotedQuantity: 2,
        unit: 'pack',
        unitPrice: 14,
      },
    ],
    subtotal: 233,
    deliveryFee: 30,
    tax: 12,
    otherCharges: 0,
    total: 275,
    currency: 'INR',
    validUntil: new Date(Date.now() + 24 * 3600 * 1000),
    deliveryEtaHours: 4,
    status: 'VALID',
    receivedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const partialQuoteMissingItem: Quote = {
    id: 'quote_missing_item',
    rfqId: 'rfq_multi_123',
    candidateId: 'cand_beta',
    supplierName: 'Beta Grocers',
    lineItems: [
      {
        productId: '44444444-4444-4444-8444-444444444401',
        productName: 'Rice (Sona Masoori)',
        quotedQuantity: 2,
        unit: 'kg',
        unitPrice: 78,
      },
      {
        productId: '44444444-4444-4444-8444-444444444402',
        productName: 'Sugar (Refined)',
        quotedQuantity: 1,
        unit: 'kg',
        unitPrice: 42,
      },
      // Missing Maggi
    ],
    subtotal: 198,
    deliveryFee: 30,
    tax: 10,
    otherCharges: 0,
    total: 238,
    currency: 'INR',
    validUntil: new Date(Date.now() + 24 * 3600 * 1000),
    deliveryEtaHours: 5,
    status: 'VALID',
    receivedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const partialQuoteShortQty: Quote = {
    id: 'quote_short_qty',
    rfqId: 'rfq_multi_123',
    candidateId: 'cand_gamma',
    supplierName: 'Gamma Stores',
    lineItems: [
      {
        productId: '44444444-4444-4444-8444-444444444401',
        productName: 'Rice (Sona Masoori)',
        quotedQuantity: 2,
        unit: 'kg',
        unitPrice: 79,
      },
      {
        productId: '44444444-4444-4444-8444-444444444402',
        productName: 'Sugar (Refined)',
        quotedQuantity: 1,
        unit: 'kg',
        unitPrice: 44,
      },
      {
        productId: '44444444-4444-4444-8444-444444444416',
        productName: 'Maggi 2-Minute Noodles',
        quotedQuantity: 1, // Short: 1 instead of 2
        unit: 'pack',
        unitPrice: 14,
      },
    ],
    subtotal: 216,
    deliveryFee: 25,
    tax: 11,
    otherCharges: 0,
    total: 252,
    currency: 'INR',
    validUntil: new Date(Date.now() + 24 * 3600 * 1000),
    deliveryEtaHours: 4,
    status: 'VALID',
    receivedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('1. QuoteSelectionComparator preserves lineItems and detects missing or short line items', () => {
    const summary = comparator.generateComparisonSummary(multiItemRFQ, [
      fullQuote,
      partialQuoteMissingItem,
      partialQuoteShortQty,
    ]);

    expect(summary.lineItems).toBeDefined();
    expect(summary.lineItems?.length).toBe(3);

    const fullMetric = summary.quotes.find((q) => q.quoteId === 'quote_full')!;
    expect(fullMetric.isPartial).toBe(false);
    expect(fullMetric.moqSatisfied).toBe(true);
    expect(fullMetric.uncoveredItems).toBeUndefined();

    const missingMetric = summary.quotes.find((q) => q.quoteId === 'quote_missing_item')!;
    expect(missingMetric.isPartial).toBe(true);
    expect(missingMetric.moqSatisfied).toBe(false);
    expect(missingMetric.uncoveredItems).toBeDefined();
    expect(missingMetric.uncoveredItems?.[0]).toContain('Maggi 2-Minute Noodles (missing)');

    const shortMetric = summary.quotes.find((q) => q.quoteId === 'quote_short_qty')!;
    expect(shortMetric.isPartial).toBe(true);
    expect(shortMetric.moqSatisfied).toBe(false);
    expect(shortMetric.uncoveredItems).toBeDefined();
    expect(shortMetric.uncoveredItems?.[0]).toContain('offered 1/2 pack');

    expect(summary.fullFulfillmentQuoteIds).toEqual(['quote_full']);
  });

  it('2. SelectionAIAdvisor formats reason covering all line items for multi-item and preserves single-item format', async () => {
    const multiSummary = comparator.generateComparisonSummary(multiItemRFQ, [fullQuote]);
    const multiRec = await advisor.recommendSelection(multiSummary);

    expect(multiRec.decision).toBe('SELECT_SUPPLIER');
    expect(multiRec.supplierId).toBe('cand_alpha');
    expect(multiRec.reason).toContain("Supplier 'Alpha Supermarket' covers all 3 items (2 kg Rice (Sona Masoori), 1 kg Sugar (Refined), 2 pack Maggi 2-Minute Noodles)");
    expect(multiRec.reason).toContain('at the lowest eligible total cost of ₹275.00');

    // Single item RFQ
    const singleRFQ: RFQ = {
      ...multiItemRFQ,
      id: 'rfq_single',
      lineItems: [
        {
          productId: '44444444-4444-4444-8444-444444444401',
          productName: 'Rice (Sona Masoori)',
          quantity: 5,
          unit: 'kg',
        },
      ],
    };
    const singleQuote: Quote = {
      ...fullQuote,
      lineItems: [
        {
          productId: '44444444-4444-4444-8444-444444444401',
          productName: 'Rice (Sona Masoori)',
          quotedQuantity: 5,
          unit: 'kg',
          unitPrice: 80,
        },
      ],
      receivedAt: new Date(),
      total: 430,
    };
    const singleSummary = comparator.generateComparisonSummary(singleRFQ, [singleQuote]);
    const singleRec = await advisor.recommendSelection(singleSummary);

    expect(singleRec.reason).toContain("Supplier 'Alpha Supermarket' satisfies 100% of demand (5 kg) at the lowest eligible total cost of ₹430.00");
  });

  it('3. PurchaseOrderService creates 3 lines matching multi-item RFQ instead of collapsing to line 0', async () => {
    const allocation: SupplierAllocation = {
      id: 'alloc_alpha',
      commitmentId: 'commit_multi',
      supplierId: 'cand_alpha',
      supplierName: 'Alpha Supermarket',
      quoteId: 'quote_full',
      allocatedQuantity: 5,
      unit: 'items',
      agreedUnitPrice: 46.6,
      lineSubtotal: 233,
      deliveryFee: 30,
      tax: 12,
      otherCharges: 0,
      totalAmount: 275,
    };

    const commitment: ProcurementCommitment = {
      id: 'commit_multi',
      rfqId: multiItemRFQ.id,
      selectedQuoteIds: ['quote_full'],
      supplierIds: ['cand_alpha'],
      product: {
        productId: multiItemRFQ.lineItems[0].productId,
        productName: multiItemRFQ.lineItems[0].productName,
        unit: multiItemRFQ.lineItems[0].unit,
      },
      lineItems: multiItemRFQ.lineItems,
      requestedQuantity: 5,
      committedQuantity: 5,
      allocations: [allocation],
      financials: {
        subtotal: 233,
        deliveryFee: 30,
        tax: 12,
        otherCharges: 0,
        total: 275,
        currency: 'INR',
      },
      deliveryDeadline: multiItemRFQ.deliveryDeadline,
      status: 'COMMITTED',
      purchaseOrderIds: [],
      recommendationReason: 'Covers all items',
      idempotencyKey: 'idemp_commit_multi',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const quoteMap = new Map([['quote_full', fullQuote]]);
    const pos = await poService.generatePurchaseOrders(commitment, multiItemRFQ, {
      quotes: quoteMap,
    });

    expect(pos.length).toBe(1);
    const po = pos[0];
    expect(po.lines.length).toBe(3);
    expect(po.lines[0]).toEqual({
      lineNumber: 1,
      productName: 'Rice (Sona Masoori)',
      quantity: 2,
      unit: 'kg',
      unitPrice: 80,
      lineTotal: 160,
    });
    expect(po.lines[1]).toEqual({
      lineNumber: 2,
      productName: 'Sugar (Refined)',
      quantity: 1,
      unit: 'kg',
      unitPrice: 45,
      lineTotal: 45,
    });
    expect(po.lines[2]).toEqual({
      lineNumber: 3,
      productName: 'Maggi 2-Minute Noodles',
      quantity: 2,
      unit: 'pack',
      unitPrice: 14,
      lineTotal: 28,
    });
  });

  it('4. ReconciliationService performs per-line quantity matching and reports breakdown & reason', async () => {
    const allocation: SupplierAllocation = {
      id: 'alloc_alpha',
      commitmentId: 'commit_multi',
      supplierId: 'cand_alpha',
      supplierName: 'Alpha Supermarket',
      quoteId: 'quote_full',
      allocatedQuantity: 5,
      unit: 'items',
      agreedUnitPrice: 46.6,
      lineSubtotal: 233,
      deliveryFee: 30,
      tax: 12,
      otherCharges: 0,
      totalAmount: 275,
    };

    const commitment: ProcurementCommitment = {
      id: 'commit_multi',
      rfqId: multiItemRFQ.id,
      selectedQuoteIds: ['quote_full'],
      supplierIds: ['cand_alpha'],
      product: {
        productId: multiItemRFQ.lineItems[0].productId,
        productName: multiItemRFQ.lineItems[0].productName,
        unit: multiItemRFQ.lineItems[0].unit,
      },
      lineItems: multiItemRFQ.lineItems,
      requestedQuantity: 5,
      committedQuantity: 5,
      allocations: [allocation],
      financials: {
        subtotal: 233,
        deliveryFee: 30,
        tax: 12,
        otherCharges: 0,
        total: 275,
        currency: 'INR',
      },
      deliveryDeadline: multiItemRFQ.deliveryDeadline,
      status: 'COMMITTED',
      purchaseOrderIds: ['po_alpha'],
      recommendationReason: 'Covers all items',
      idempotencyKey: 'idemp_commit_multi_rec',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const residentAllocations: ResidentAllocation[] = [
      {
        id: 'alloc_res_1',
        commitmentId: commitment.id,
        purchaseOrderId: 'po_alpha',
        residentOrderId: 'ro_1',
        residentReference: 'res_1',
        productId: '44444444-4444-4444-8444-444444444401',
        productName: 'Rice (Sona Masoori)',
        requestedQuantity: 2,
        allocatedQuantity: 2,
        unit: 'kg',
        unitPrice: 80,
        subtotal: 160,
        allocatedTax: 8,
        allocatedDeliveryFee: 20,
        allocatedOtherCharges: 0,
        totalAmount: 188,
        allocationStatus: 'FINALIZED',
        reconciliationStatus: 'PENDING',
        idempotencyKey: 'idemp_res_1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'alloc_res_2',
        commitmentId: commitment.id,
        purchaseOrderId: 'po_alpha',
        residentOrderId: 'ro_1',
        residentReference: 'res_1',
        productId: '44444444-4444-4444-8444-444444444402',
        productName: 'Sugar (Refined)',
        requestedQuantity: 1,
        allocatedQuantity: 1,
        unit: 'kg',
        unitPrice: 45,
        subtotal: 45,
        allocatedTax: 2,
        allocatedDeliveryFee: 5,
        allocatedOtherCharges: 0,
        totalAmount: 52,
        allocationStatus: 'FINALIZED',
        reconciliationStatus: 'PENDING',
        idempotencyKey: 'idemp_res_2',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'alloc_res_3',
        commitmentId: commitment.id,
        purchaseOrderId: 'po_alpha',
        residentOrderId: 'ro_1',
        residentReference: 'res_1',
        productId: '44444444-4444-4444-8444-444444444416',
        productName: 'Maggi 2-Minute Noodles',
        requestedQuantity: 2,
        allocatedQuantity: 2,
        unit: 'pack',
        unitPrice: 14,
        subtotal: 28,
        allocatedTax: 2,
        allocatedDeliveryFee: 5,
        allocatedOtherCharges: 0,
        totalAmount: 35,
        allocationStatus: 'FINALIZED',
        reconciliationStatus: 'PENDING',
        idempotencyKey: 'idemp_res_3',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const verifiedFulfillment: FulfillmentOrder = {
      id: 'ful_alpha',
      commitmentId: commitment.id,
      purchaseOrderId: 'po_alpha',
      paymentId: 'pay_alpha',
      supplierId: 'cand_alpha',
      supplierName: 'Alpha Supermarket',
      fulfillmentType: 'PHYSICAL_GOODS',
      status: 'VERIFIED',
      productName: 'Rice (Sona Masoori)',
      requestedQuantity: 5,
      fulfilledQuantity: 5,
      remainingQuantity: 0,
      unit: 'items',
      deliveryArea: 'Gate 1',
      slaDeadline: new Date(Date.now() + 12 * 3600 * 1000),
      slaStatus: 'ON_TRACK',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const payment: Payment = {
      id: 'pay_alpha',
      commitmentId: commitment.id,
      purchaseOrderId: 'po_alpha',
      paymentMandateId: 'mand_1',
      supplierId: 'cand_alpha',
      amount: 275,
      currency: 'INR',
      status: 'SUCCEEDED',
      direction: 'OUTBOUND',
      paymentMethod: 'ESCROW_WALLET',
      idempotencyKey: 'idemp_pay',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Full match case
    const matchResult = reconService.reconcileCommitment({
      commitment,
      fulfillments: [verifiedFulfillment],
      allocations: residentAllocations,
      payments: [payment],
    });

    expect(matchResult.status).toBe('RECONCILED');
    expect(matchResult.isQuantityMatched).toBe(true);
    expect(matchResult.lineItems).toBeDefined();
    expect(matchResult.lineItems?.length).toBe(3);
    expect(matchResult.lineItems?.every((l) => l.isMatched)).toBe(true);
    expect(matchResult.reason).toBe(
      'Delivered quantities match allocated quantities across all 3 line items.'
    );

    // Mismatch case: one line artificially altered
    const mismatchedAllocations = residentAllocations.map((a) =>
      a.productId === '44444444-4444-4444-8444-444444444416'
        ? { ...a, allocatedQuantity: 3 } // 3 instead of 2
        : a
    );

    const mismatchResult = reconService.reconcileCommitment({
      commitment,
      fulfillments: [verifiedFulfillment],
      allocations: mismatchedAllocations,
      payments: [payment],
      idempotencyKey: 'idemp_mismatch_test',
    });

    expect(mismatchResult.status).toBe('DISCREPANCY');
    expect(mismatchResult.isQuantityMatched).toBe(false);
    expect(mismatchResult.lineItems?.some((l) => !l.isMatched)).toBe(true);
    expect(mismatchResult.reason).toContain('Delivered quantities mismatch allocated quantities for:');
    expect(mismatchResult.reason).toContain('Maggi 2-Minute Noodles');
  });
});
