import { describe, it, expect } from 'vitest';
import { AllocationService } from '../src/allocation/AllocationService';
import { AllocationEngine } from '../src/allocation/AllocationEngine';
import { CostAllocationService } from '../src/allocation/CostAllocationService';
import { ResidentLedgerService } from '../src/allocation/ResidentLedgerService';
import { ReconciliationService } from '../src/allocation/ReconciliationService';
import { AllocationAuditService } from '../src/allocation/AllocationAuditService';
import { ResidentDemand } from '../src/allocation/types';
import { resolveDemandLineIds } from '../src/allocation/demandLineKey';
import { ProcurementCommitment } from '../src/discovery/supplier/selection/types';
import { FulfillmentOrder } from '../src/fulfillment/types';

const ORDER_ID = 'ro_multi_4item';
const RESIDENT_REF = 'res_ref_multi';

/** Recording-audit request: 4 lines sharing one resident order ID. */
function buildFourItemDemands(): ResidentDemand[] {
  return [
    {
      residentOrderId: ORDER_ID,
      residentId: 'res_id_multi',
      residentReference: RESIDENT_REF,
      productId: 'prod_parle_g',
      productName: 'Parle-G',
      requestedQuantity: 2,
      unit: 'packs',
    },
    {
      residentOrderId: ORDER_ID,
      residentId: 'res_id_multi',
      residentReference: RESIDENT_REF,
      productId: 'prod_maida',
      productName: 'maida',
      requestedQuantity: 6,
      unit: 'kg',
    },
    {
      residentOrderId: ORDER_ID,
      residentId: 'res_id_multi',
      residentReference: RESIDENT_REF,
      productId: 'prod_bajra_atta',
      productName: 'bajra atta',
      requestedQuantity: 4,
      unit: 'kg',
    },
    {
      residentOrderId: ORDER_ID,
      residentId: 'res_id_multi',
      residentReference: RESIDENT_REF,
      productId: 'prod_sabudana',
      productName: 'sabudana',
      requestedQuantity: 25,
      unit: 'kg',
    },
  ];
}

function buildCommitment(id: string): ProcurementCommitment {
  const now = new Date();
  return {
    id,
    rfqId: `rfq_${id}`,
    selectedQuoteIds: ['q_multi_1'],
    supplierIds: ['sup_multi'],
    product: {
      productId: 'prod_multi_mix',
      productName: 'Multi-item mix',
      unit: 'units',
    },
    requestedQuantity: 37,
    committedQuantity: 37,
    allocations: [
      {
        id: `sup_alloc_${id}`,
        commitmentId: id,
        supplierId: 'sup_multi',
        supplierName: 'Multi Mart Wholesale',
        quoteId: 'q_multi_1',
        allocatedQuantity: 37,
        unit: 'units',
        agreedUnitPrice: 100,
        lineSubtotal: 3700,
        deliveryFee: 100,
        tax: 185,
        otherCharges: 15,
        totalAmount: 4000,
      },
    ],
    financials: {
      subtotal: 3700,
      deliveryFee: 100,
      tax: 185,
      otherCharges: 15,
      total: 4000,
      currency: 'INR',
    },
    deliveryDeadline: new Date(now.getTime() + 12 * 3600 * 1000),
    status: 'PAID',
    purchaseOrderIds: [`po_${id}`],
    recommendationReason: 'Focused evidence-labeling fixture',
    idempotencyKey: `idemp_${id}`,
    createdAt: now,
    updatedAt: now,
  };
}

function buildFulfillment(commitmentId: string, fulfilledQuantity: number): FulfillmentOrder {
  const now = new Date();
  return {
    id: `ful_${commitmentId}_${fulfilledQuantity}`,
    commitmentId,
    purchaseOrderId: `po_${commitmentId}`,
    paymentId: `pay_${commitmentId}`,
    supplierId: 'sup_multi',
    supplierName: 'Multi Mart Wholesale',
    fulfillmentType: 'PHYSICAL_GOODS',
    status: 'VERIFIED',
    productName: 'Multi-item mix',
    requestedQuantity: 37,
    fulfilledQuantity,
    remainingQuantity: 37 - fulfilledQuantity,
    unit: 'units',
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
}

function buildService(): AllocationService {
  const audit = new AllocationAuditService();
  return new AllocationService(
    new AllocationEngine(),
    new CostAllocationService(),
    new ResidentLedgerService(audit),
    new ReconciliationService(audit),
    audit
  );
}

describe('Allocation evidence labeling: per-line demand identity', () => {
  it('1. Multi-line order keeps each line\'s own product name/unit (no line-1 bleed)', () => {
    const demands = buildFourItemDemands();
    const summary = buildService().prepareAllocation({
      commitment: buildCommitment('comm_evidence_labels'),
      fulfillments: [buildFulfillment('comm_evidence_labels', 37)],
      residentDemands: demands,
    });

    expect(summary.allocations).toHaveLength(4);
    const byLineId = new Map(demands.map((d, i) => [resolveDemandLineIds(demands)[i], d]));
    for (const alloc of summary.allocations) {
      const demand = byLineId.get(alloc.demandLineId!);
      expect(demand, `allocation ${alloc.id} must join to its own demand line`).toBeDefined();
      expect(alloc.productName).toBe(demand!.productName);
      expect(alloc.unit).toBe(demand!.unit);
      expect(alloc.productId).toBe(demand!.productId);
      expect(alloc.residentOrderId).toBe(ORDER_ID);
    }
    // Explicit regression pins: lines 2-4 must not repeat line-1 labels.
    expect(summary.allocations.map((a) => a.productName)).toEqual([
      'Parle-G',
      'maida',
      'bajra atta',
      'sabudana',
    ]);
    expect(summary.allocations.map((a) => a.unit)).toEqual(['packs', 'kg', 'kg', 'kg']);
  });

  it('2. Financial amounts and quantities stay conserved for the 4-item request', () => {
    const demands = buildFourItemDemands();
    const summary = buildService().prepareAllocation({
      commitment: buildCommitment('comm_evidence_money'),
      fulfillments: [buildFulfillment('comm_evidence_money', 37)],
      residentDemands: demands,
    });

    expect(summary.totalRequestedQuantity).toBe(37);
    expect(summary.totalAllocatedQuantity).toBe(37);
    expect(summary.totalResidentAllocatedAmount).toBe(4000);
    for (const alloc of summary.allocations) {
      expect(alloc.allocatedQuantity).toBe(alloc.requestedQuantity);
      expect(
        alloc.subtotal + alloc.allocatedTax + alloc.allocatedDeliveryFee + alloc.allocatedOtherCharges
      ).toBeCloseTo(alloc.totalAmount, 10);
    }
    const total = summary.allocations.reduce((s, a) => s + a.totalAmount, 0);
    expect(total).toBeCloseTo(4000, 10);
  });

  it('3. Per-line keys are deterministic; legacy unique order IDs keep identity', () => {
    const demands = buildFourItemDemands();
    const first = resolveDemandLineIds(demands);
    const second = resolveDemandLineIds(buildFourItemDemands());
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(4);

    const legacy: ResidentDemand[] = [
      { ...demands[0], residentOrderId: 'ro_legacy_a' },
      { ...demands[1], residentOrderId: 'ro_legacy_b' },
    ];
    expect(resolveDemandLineIds(legacy)).toEqual(['ro_legacy_a', 'ro_legacy_b']);

    const explicit: ResidentDemand[] = [
      { ...demands[0], demandLineId: 'custom_line_9' },
      { ...demands[1], demandLineId: 'custom_line_3' },
    ];
    expect(resolveDemandLineIds(explicit)).toEqual(['custom_line_9', 'custom_line_3']);
  });

  it('4. Partial fulfillment conserves quantity per line with correct labels', () => {
    const demands = buildFourItemDemands();
    const summary = buildService().prepareAllocation({
      commitment: buildCommitment('comm_evidence_partial'),
      fulfillments: [buildFulfillment('comm_evidence_partial', 30)],
      residentDemands: demands,
    });

    expect(summary.totalAllocatedQuantity).toBe(30);
    for (const alloc of summary.allocations) {
      expect(alloc.allocatedQuantity).toBeLessThanOrEqual(alloc.requestedQuantity);
    }
    expect(summary.allocations.map((a) => a.productName)).toEqual([
      'Parle-G',
      'maida',
      'bajra atta',
      'sabudana',
    ]);
    const total = summary.allocations.reduce((s, a) => s + a.totalAmount, 0);
    expect(total).toBeCloseTo(4000, 10);
  });
});
