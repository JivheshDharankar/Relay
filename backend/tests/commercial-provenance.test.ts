/**
 * Phase 17.2 Correction 3 — simulated commercial provenance is end-to-end
 * truthful: response → quote → selection → commitment → PO → payment →
 * fulfillment → allocation → reconciliation.
 *
 * Supplier identity (candidate.source: geoapify/mock) stays independent of
 * commercial provenance (isSimulated / commercialBasisSimulated).
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { ProductUnit } from '@prisma/client';
import { RFQService } from '../src/discovery/supplier/rfq/RFQService';
import { SupplierResponseService } from '../src/discovery/supplier/quote/provider/SupplierResponseService';
import { QuoteNormalizationService } from '../src/discovery/supplier/quote/QuoteNormalizationService';
import {
  SupplierCandidate,
  Quote,
  ProcurementCommitment,
  quoteSelectionComparator,
  selectionAIAdvisor,
  selectionValidator,
} from '../src/discovery/supplier';
import { ProcurementCommitmentService } from '../src/discovery/supplier/selection/ProcurementCommitmentService';
import { PurchaseOrderService } from '../src/discovery/supplier/selection/PurchaseOrderService';
import { AllocationService as SelectionAllocationService } from '../src/discovery/supplier/selection/AllocationService';
import {
  MandateService,
  PaymentService,
  PaymentAuthorizationService,
  PaymentExecutionService,
  paymentAuthorizationValidator,
  mockPaymentProvider,
} from '../src/payment';
import { FulfillmentOrderService, FulfillmentEventService } from '../src/fulfillment';
import { AllocationService, ResidentDemand } from '../src/allocation';

const PRODUCT = 'maida';
const QUANTITY = 2;

function candidate(i: number): SupplierCandidate {
  return {
    id: `cand_prov_${i}`,
    name: `Provenance Supplier ${i}`,
    address: `${i} Truth Market, Pune`,
    latitude: 18.5 + i * 0.001,
    longitude: 73.85 + i * 0.001,
    categories: ['commercial.supermarket'],
    source: 'mock',
    email: `prov${i}@example.com`,
    phone: `+9198765433${10 + i}`,
  };
}

function freshServices() {
  const rfqService = new RFQService();
  const responseService = new SupplierResponseService(rfqService);
  const normalizationService = new QuoteNormalizationService();
  const poService = new PurchaseOrderService();
  const commitmentService = new ProcurementCommitmentService(
    rfqService,
    normalizationService,
    quoteSelectionComparator,
    selectionAIAdvisor,
    selectionValidator,
    new SelectionAllocationService(),
    poService
  );
  const mandateService = new MandateService();
  const executionService = new PaymentExecutionService(mockPaymentProvider, mandateService);
  const paymentService = new PaymentService(
    commitmentService,
    poService,
    mandateService,
    new PaymentAuthorizationService(paymentAuthorizationValidator, mandateService),
    executionService
  );
  return {
    rfqService,
    responseService,
    normalizationService,
    commitmentService,
    poService,
    mandateService,
    paymentService,
    fulfillmentOrderService: new FulfillmentOrderService(),
    fulfillmentEventService: new FulfillmentEventService(),
    allocationService: new AllocationService(),
  };
}

type Services = ReturnType<typeof freshServices>;

async function rfqFor(services: Services, cand: SupplierCandidate, tag: string) {
  const now = new Date();
  return services.rfqService.createRFQ({
    candidate: cand,
    lineItems: [{ productName: PRODUCT, quantity: QUANTITY, unit: ProductUnit.KG }],
    deliveryArea: 'Greenview Residency Central Depot',
    deliveryDeadline: new Date(now.getTime() + 12 * 3600 * 1000),
    quoteDeadline: new Date(now.getTime() + 4 * 3600 * 1000),
    idempotencyKey: `prov_${tag}_${randomUUID()}`,
  });
}

async function quoteFor(
  services: Services,
  rfqId: string,
  cand: SupplierCandidate,
  opts: { unitPrice: number; eta?: number; quantity?: number; isSimulated?: boolean }
): Promise<Quote> {
  const resp = await services.responseService.ingestResponse({
    rfqId,
    candidateId: cand.id,
    supplierName: cand.name,
    channel: 'manual',
    lineItems: [
      {
        productName: PRODUCT,
        quotedQuantity: opts.quantity ?? QUANTITY,
        unit: ProductUnit.KG,
        unitPrice: opts.unitPrice,
      },
    ],
    deliveryFee: 40,
    deliveryEtaHours: opts.eta ?? 6,
    ...(opts.isSimulated === undefined ? {} : { isSimulated: opts.isSimulated }),
  });
  return (await services.normalizationService.normalizeResponse(resp)).quote;
}

async function fullChain(
  services: Services,
  quote: Quote,
  rfqId: string,
  mandateId: string,
  residentRef: string
) {
  const { commitment, purchaseOrders } = await services.commitmentService.createCommitment({
    rfqId,
    recommendation: {
      decision: 'SELECT_SUPPLIER',
      supplierId: quote.candidateId,
      quoteId: quote.id,
      reason: 'provenance probe',
    },
  });
  const po = purchaseOrders[0];
  const payment = (
    await services.paymentService.payCommitment({ commitmentId: commitment.id, ownerReference: residentRef, mandateId })
  ).payments[0];
  const order = services.fulfillmentOrderService.createFulfillmentOrder({
    commitment,
    purchaseOrder: po,
    payment,
    deliveryArea: 'Greenview Residency Central Depot',
  });
  for (const eventType of [
    'SUPPLIER_ACCEPTED',
    'ORDER_PACKED',
    'ORDER_DISPATCHED',
    'ORDER_IN_TRANSIT',
    'ORDER_DELIVERED',
  ] as const) {
    await services.fulfillmentEventService.ingestEvent(order, {
      id: `evt_prov_${randomUUID()}`,
      fulfillmentId: order.id,
      supplierId: order.supplierId,
      eventType,
      ...(eventType === 'ORDER_DELIVERED'
        ? { quantityFulfilled: order.requestedQuantity }
        : {}),
      idempotencyKey: `idemp_prov_${eventType}_${randomUUID().slice(0, 6)}`,
      timestamp: new Date(),
    });
  }
  const verified = services.fulfillmentOrderService.verifyFulfillment(order.id, {
    evidenceType: 'DELIVERY_CONFIRMATION',
    verifiedBy: 'Society Hub Manager',
    verifiedAt: new Date(),
    isSimulated: true,
  });
  const demands: ResidentDemand[] = [
    {
      residentOrderId: `ro_prov_${randomUUID()}`,
      residentId: residentRef,
      residentReference: residentRef,
      productId: 'prod_maida_probe',
      productName: PRODUCT,
      requestedQuantity: QUANTITY,
      unit: ProductUnit.KG,
    },
  ];
  services.allocationService.prepareAllocation({
    commitment,
    fulfillments: [verified],
    residentDemands: demands,
  });
  const finalized = await services.allocationService.finalizeAllocation({
    commitmentId: commitment.id,
    payments: [payment],
    purchaseOrders: [po],
  });
  return { commitment, po, payment, order, verified, finalized };
}

describe('Phase 17.2 — commercial provenance', () => {
  it('1. isSimulated survives supplier response → normalized quote', async () => {
    const services = freshServices();
    const cand = candidate(0);
    const rfq = await rfqFor(services, cand, 'r2q');
    const simulated = await quoteFor(services, rfq.id, cand, {
      unitPrice: 45,
      isSimulated: true,
    });
    expect(simulated.isSimulated).toBe(true);
    const unmarked = await quoteFor(services, rfq.id, cand, { unitPrice: 45 });
    expect(unmarked.isSimulated).toBeUndefined();
  });

  it('2. Winning quote retains provenance and the reason states it', async () => {
    const services = freshServices();
    const cands = [candidate(0), candidate(1)];
    const rfqs = [await rfqFor(services, cands[0], 'w0'), await rfqFor(services, cands[1], 'w1')];
    const expensiveReal = await quoteFor(services, rfqs[0].id, cands[0], {
      unitPrice: 100,
      isSimulated: false,
    });
    const cheapSimulated = await quoteFor(services, rfqs[1].id, cands[1], {
      unitPrice: 30,
      isSimulated: true,
    });
    void expensiveReal;
    const comparison = quoteSelectionComparator.generateComparisonSummary(rfqs[0], [
      expensiveReal,
      cheapSimulated,
    ]);
    const winnerMetrics = comparison.quotes.find((q) => q.quoteId === cheapSimulated.id)!;
    expect(winnerMetrics.isSimulated).toBe(true);
    const recommendation = await selectionAIAdvisor.recommendSelection(comparison);
    expect(recommendation.quoteId).toBe(cheapSimulated.id);
    expect(recommendation.reason).toContain('simulated commercial response');
  });

  it('3. Commitment and PO identify the commercial provenance', async () => {
    const services = freshServices();
    const cand = candidate(0);
    const rfq = await rfqFor(services, cand, 'cp');
    const quote = await quoteFor(services, rfq.id, cand, { unitPrice: 45, isSimulated: true });
    const { commitment, purchaseOrders } = await services.commitmentService.createCommitment({
      rfqId: rfq.id,
      recommendation: {
        decision: 'SELECT_SUPPLIER',
        supplierId: quote.candidateId,
        quoteId: quote.id,
        reason: 'provenance probe',
      },
    });
    expect(commitment.commercialBasisSimulated).toBe(true);
    expect(purchaseOrders[0].commercialBasisSimulated).toBe(true);

    const cand2 = candidate(1);
    const rfq2 = await rfqFor(services, cand2, 'cp2');
    const realQuote = await quoteFor(services, rfq2.id, cand2, {
      unitPrice: 45,
      isSimulated: false,
    });
    const real = await services.commitmentService.createCommitment({
      rfqId: rfq2.id,
      recommendation: {
        decision: 'SELECT_SUPPLIER',
        supplierId: realQuote.candidateId,
        quoteId: realQuote.id,
        reason: 'provenance probe',
      },
    });
    expect(real.commitment.commercialBasisSimulated).toBe(false);
    expect(real.purchaseOrders[0].commercialBasisSimulated).toBe(false);
  });

  it('4. Payment, fulfillment, allocation, and reconciliation trace the basis', async () => {
    const services = freshServices();
    const residentRef = `res_prov_${randomUUID().slice(0, 8)}`;
    const mandate = services.mandateService.createMandate({
      ownerReference: residentRef,
      purpose: 'COMMUNITY_PROCUREMENT',
      spendingLimit: 500000,
      currency: 'INR',
    });
    const cand = candidate(0);
    const rfq = await rfqFor(services, cand, 'e2e');
    const quote = await quoteFor(services, rfq.id, cand, { unitPrice: 45, isSimulated: true });
    const { commitment, po, payment, order, finalized } = await fullChain(
      services,
      quote,
      rfq.id,
      mandate.id,
      residentRef
    );
    expect(commitment.commercialBasisSimulated).toBe(true);
    expect(po.commercialBasisSimulated).toBe(true);
    expect(payment.commercialBasisSimulated).toBe(true);
    expect(order.commercialBasisSimulated).toBe(true);
    expect(finalized.summary.commercialBasisSimulated).toBe(true);
    expect(finalized.reconciliation.commercialBasisSimulated).toBe(true);
    // Financial invariants untouched by provenance marking.
    expect(finalized.reconciliation.status).toBe('RECONCILED');
    expect(finalized.reconciliation.discrepancies).toHaveLength(0);
  });

  it('5. Serialized records carry the marker and never claim a real quote', async () => {
    const services = freshServices();
    const cand = candidate(0);
    const rfq = await rfqFor(services, cand, 'ser');
    const quote = await quoteFor(services, rfq.id, cand, { unitPrice: 45, isSimulated: true });
    const comparison = quoteSelectionComparator.generateComparisonSummary(rfq, [quote]);
    const recommendation = await selectionAIAdvisor.recommendSelection(comparison);
    const serialized = JSON.stringify({ quote, recommendation });
    expect(serialized).toContain('simulated commercial response');
    expect(serialized).not.toMatch(/supplier quoted|live supplier quote|actual supplier quote/i);
  });

  it('6. Supplier identity stays distinguishable from commercial behavior', async () => {
    const services = freshServices();
    // Mock-identified supplier with a real-channel response: identity says
    // mock, commercial basis says real — the axes are independent.
    const cand = candidate(0);
    expect(cand.source).toBe('mock');
    const rfq = await rfqFor(services, cand, 'axes');
    const quote = await quoteFor(services, rfq.id, cand, {
      unitPrice: 45,
      isSimulated: false,
    });
    expect(quote.isSimulated).toBe(false);
    // And the reverse: discovered identity with simulated commercials.
    const geoCand: SupplierCandidate = { ...candidate(1), source: 'geoapify' };
    const rfq2 = await rfqFor(services, geoCand, 'axes2');
    const simQuote = await quoteFor(services, rfq2.id, geoCand, {
      unitPrice: 45,
      isSimulated: true,
    });
    expect(geoCand.source).toBe('geoapify');
    expect(simQuote.isSimulated).toBe(true);
  });

  it('7. Mixed real/simulated bases cannot collapse into "real"', async () => {
    const services = freshServices();
    const cands = [candidate(0), candidate(1)];
    const rfq = await rfqFor(services, cands[0], 'mix');
    // Two partial quotes (1kg each of 2kg) with mixed provenance.
    const realPartial = await quoteFor(services, rfq.id, cands[0], {
      unitPrice: 40,
      quantity: 1,
      isSimulated: false,
    });
    void realPartial;
    const rfq2 = await rfqFor(services, cands[1], 'mix2');
    const simPartial = await quoteFor(services, rfq2.id, cands[1], {
      unitPrice: 42,
      quantity: 1,
      isSimulated: true,
    });
    void simPartial;
    const { commitment } = await services.commitmentService.createCommitment({
      rfqId: rfq.id,
      recommendation: {
        decision: 'SPLIT_ORDER',
        allocations: [
          { supplierId: cands[0].id, quoteId: realPartial.id, quantity: 1 },
          { supplierId: cands[1].id, quoteId: simPartial.id, quantity: 1 },
        ],
        reason: 'mixed provenance probe',
      },
    });
    expect(commitment.commercialBasisSimulated).toBe(true);
  });

  it('8. Unknown provenance stays unknown (never defaults to real)', async () => {
    const services = freshServices();
    const cand = candidate(0);
    const rfq = await rfqFor(services, cand, 'unk');
    const quote = await quoteFor(services, rfq.id, cand, { unitPrice: 45 });
    expect(quote.isSimulated).toBeUndefined();
    const { commitment } = await services.commitmentService.createCommitment({
      rfqId: rfq.id,
      recommendation: {
        decision: 'SELECT_SUPPLIER',
        supplierId: quote.candidateId,
        quoteId: quote.id,
        reason: 'unknown provenance probe',
      },
    });
    expect(commitment.commercialBasisSimulated).toBeUndefined();
  });
});
