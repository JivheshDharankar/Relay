import { randomUUID } from 'crypto';
import { roundMoney } from '../domain/procurement/decimal';
import { ProcurementCommitment, PurchaseOrder } from '../discovery/supplier/selection/types';
import { FulfillmentOrder } from '../fulfillment/types';
import { Payment } from '../payment/types';
import { AllocationAuditService, allocationAuditService } from './AllocationAuditService';
import { AllocationEngine, allocationEngine } from './AllocationEngine';
import { CostAllocationService, costAllocationService } from './CostAllocationService';
import { attachDemandLineIds } from './demandLineKey';
import { ReconciliationService, reconciliationService } from './ReconciliationService';
import { ResidentLedgerService, residentLedgerService } from './ResidentLedgerService';
import { assertLegalAllocationTransition } from './stateMachine';
import {
  AllocationExplanation,
  ReconciliationResult,
  ResidentAllocation,
  ResidentAllocationSummary,
  ResidentDemand,
  ResidentLedgerEntry,
} from './types';
import {
  AllocationValidationError,
  validateFulfillmentEntryCondition,
  validateMonetaryConservation,
  validateNonNegativity,
  validateQuantityConservation,
  validateResidentAuthorization,
} from './validation';

export interface PrepareAllocationInput {
  commitment: ProcurementCommitment;
  fulfillments: FulfillmentOrder[];
  residentDemands: ResidentDemand[];
  allowFractions?: boolean;
  idempotencyKey?: string;
}

export interface FinalizeAllocationInput {
  commitmentId: string;
  payments: Payment[];
  purchaseOrders?: PurchaseOrder[];
}

export class AllocationService {
  private summaries = new Map<string, ResidentAllocationSummary>();
  private allocations = new Map<string, ResidentAllocation>();
  private allocationsByCommitment = new Map<string, ResidentAllocation[]>();
  private allocationsByResident = new Map<string, ResidentAllocation[]>();
  private allocationsByOrder = new Map<string, ResidentAllocation>();
  private fulfillmentsByCommitment = new Map<string, FulfillmentOrder[]>();
  private commitments = new Map<string, ProcurementCommitment>();
  private idempotencyStore = new Map<string, ResidentAllocationSummary>();
  private mutexes = new Map<string, Promise<void>>();

  constructor(
    private readonly engine: AllocationEngine = allocationEngine,
    private readonly costService: CostAllocationService = costAllocationService,
    private readonly ledgerService: ResidentLedgerService = residentLedgerService,
    private readonly reconService: ReconciliationService = reconciliationService,
    private readonly auditService: AllocationAuditService = allocationAuditService
  ) {}

  /**
   * Prepares and calculates initial resident allocations from verified fulfillment.
   * Status: CALCULATED.
   */
  public prepareAllocation(input: PrepareAllocationInput): ResidentAllocationSummary {
    const { commitment, fulfillments, residentDemands: inputDemands, allowFractions = false } = input;
    const dedupeKey = input.idempotencyKey || `alloc_summary_${commitment.id}_${fulfillments.length}`;

    // 1. Idempotency Check
    if (this.idempotencyStore.has(dedupeKey)) {
      return this.idempotencyStore.get(dedupeKey)!;
    }

    // 2. Entry Condition: All fulfillments must be VERIFIED
    validateFulfillmentEntryCondition(fulfillments);

    this.auditService.emit('ALLOCATION_STARTED', commitment.id, {
      commitmentId: commitment.id,
      fulfilledOrderCount: fulfillments.length,
      residentDemandCount: inputDemands.length,
    });

    // Resolve stable per-line demand keys so shared-order lines join
    // deterministically below instead of collapsing onto the first demand.
    const residentDemands = attachDemandLineIds(inputDemands);

    const totalVerifiedFulfilled = fulfillments.reduce(
      (sum, f) => sum + f.fulfilledQuantity,
      0
    );

    // 3. Deterministic Quantity Allocation (Whole-Unit Hamilton-Hare or Fractional)
    const quantityResults = this.engine.allocateQuantities({
      residentDemands,
      verifiedFulfilledQuantity: totalVerifiedFulfilled,
      allowFractions,
    });

    // 4. Deterministic Cost Allocation with exact Paise Rounding Reconciliation
    const costResults = this.costService.allocateCosts(quantityResults, {
      unitPrice:
        fulfillments.length > 0 && fulfillments[0].requestedQuantity > 0
          ? roundMoney(commitment.financials.subtotal / totalVerifiedFulfilled).toNumber()
          : undefined,
      subtotal: commitment.financials.subtotal,
      tax: commitment.financials.tax,
      deliveryFee: commitment.financials.deliveryFee,
      otherCharges: commitment.financials.otherCharges,
      total: commitment.financials.total,
      currency: commitment.financials.currency || 'INR',
    });

    // Contributing supplier IDs for multi-supplier traceability (zero competitor price leakage)
    const contributingSupplierIds = Array.from(new Set(fulfillments.map((f) => f.supplierId)));

    const now = new Date();
    const demandByLineId = new Map<string, ResidentDemand>(
      residentDemands.map((d) => [d.demandLineId ?? d.residentOrderId, d])
    );
    const residentAllocations: ResidentAllocation[] = costResults.map((cost) => {
      const demandLineId = cost.demandLineId ?? cost.residentOrderId;
      const demand =
        demandByLineId.get(demandLineId) ??
        residentDemands.find((d) => d.residentOrderId === cost.residentOrderId)!;
      const allocId = `alloc_${randomUUID().slice(0, 10)}`;
      return {
        id: allocId,
        commitmentId: commitment.id,
        purchaseOrderId: fulfillments[0]?.purchaseOrderId,
        fulfillmentOrderId: fulfillments[0]?.id,
        residentOrderId: cost.residentOrderId,
        demandLineId,
        residentReference: cost.residentReference,
        productId: demand.productId,
        productName: demand.productName,
        requestedQuantity: cost.requestedQuantity,
        allocatedQuantity: cost.allocatedQuantity,
        unit: demand.unit,
        unitPrice: cost.unitPrice,
        subtotal: cost.subtotal,
        allocatedTax: cost.allocatedTax,
        allocatedDeliveryFee: cost.allocatedDeliveryFee,
        allocatedOtherCharges: cost.allocatedOtherCharges,
        totalAmount: cost.totalAmount,
        allocationStatus: 'CALCULATED',
        reconciliationStatus: 'PENDING',
        idempotencyKey: `${commitment.id}_${demandLineId}_v1`,
        contributingSupplierIds,
        createdAt: now,
        updatedAt: now,
      };
    });

    const totalRequested = residentDemands.reduce((sum, d) => sum + d.requestedQuantity, 0);
    const totalAllocated = residentAllocations.reduce((sum, a) => sum + a.allocatedQuantity, 0);
    const totalResidentAmount = residentAllocations.reduce(
      (sum, a) => sum + a.totalAmount,
      0
    );

    const summary: ResidentAllocationSummary = {
      commitmentId: commitment.id,
      totalRequestedQuantity: totalRequested,
      totalAllocatedQuantity: totalAllocated,
      totalProcurementCost: commitment.financials.total,
      totalResidentAllocatedAmount: roundMoney(totalResidentAmount).toNumber(),
      residentCount: residentAllocations.length,
      status: 'CALCULATED',
      reconciliationStatus: 'PENDING',
      allocations: residentAllocations,
      calculatedAt: now,
      commercialBasisSimulated: commitment.commercialBasisSimulated,
    };

    // Store state
    this.summaries.set(commitment.id, summary);
    this.fulfillmentsByCommitment.set(commitment.id, fulfillments);
    this.commitments.set(commitment.id, commitment);
    this.allocationsByCommitment.set(commitment.id, residentAllocations);

    for (const alloc of residentAllocations) {
      this.allocations.set(alloc.id, alloc);
      this.allocationsByOrder.set(alloc.residentOrderId, alloc);

      const resList = this.allocationsByResident.get(alloc.residentReference) || [];
      resList.push(alloc);
      this.allocationsByResident.set(alloc.residentReference, resList);
    }

    this.idempotencyStore.set(dedupeKey, summary);

    this.auditService.emit('ALLOCATION_CALCULATED', commitment.id, {
      commitmentId: commitment.id,
      allocatedQuantity: totalAllocated,
      totalAmount: summary.totalResidentAllocatedAmount,
    });

    return summary;
  }

  /**
   * Validates calculated allocations against quantity conservation and monetary integrity.
   * Status: VALIDATED.
   */
  public validateAllocation(commitmentId: string): ResidentAllocationSummary {
    const summary = this.summaries.get(commitmentId);
    if (!summary) {
      throw new AllocationValidationError([
        `ALLOCATION_NOT_FOUND: No allocation calculated for commitment '${commitmentId}'`,
      ]);
    }

    assertLegalAllocationTransition(summary.status, 'VALIDATED');

    const fulfillments = this.fulfillmentsByCommitment.get(commitmentId) || [];
    const totalVerifiedFulfilled = fulfillments.reduce(
      (sum, f) => sum + f.fulfilledQuantity,
      0
    );

    // Validate fundamental quantity conservation
    validateQuantityConservation(summary.totalAllocatedQuantity, totalVerifiedFulfilled);

    // Validate monetary conservation
    validateMonetaryConservation(
      summary.totalResidentAllocatedAmount,
      summary.totalProcurementCost
    );

    // Validate individual non-negativity
    for (const alloc of summary.allocations) {
      validateNonNegativity({
        requestedQuantity: alloc.requestedQuantity,
        allocatedQuantity: alloc.allocatedQuantity,
        unitPrice: alloc.unitPrice,
        subtotal: alloc.subtotal,
        allocatedTax: alloc.allocatedTax,
        allocatedDeliveryFee: alloc.allocatedDeliveryFee,
        allocatedOtherCharges: alloc.allocatedOtherCharges,
        totalAmount: alloc.totalAmount,
      });
    }

    summary.status = 'VALIDATED';
    for (const alloc of summary.allocations) {
      alloc.allocationStatus = 'VALIDATED';
      alloc.updatedAt = new Date();
    }

    this.auditService.emit('ALLOCATION_VALIDATED', commitmentId, {
      commitmentId,
      status: summary.status,
    });

    return summary;
  }

  /**
   * Atomically finalizes the allocation, posts immutable resident ledger entries,
   * and runs complete deterministic 4-pillar reconciliation.
   */
  public async finalizeAllocation(
    input: FinalizeAllocationInput
  ): Promise<{
    summary: ResidentAllocationSummary;
    ledgerEntries: ResidentLedgerEntry[];
    reconciliation: ReconciliationResult;
  }> {
    const { commitmentId, payments, purchaseOrders } = input;

    // Mutex locking to prevent concurrent finalization race conditions
    await this.acquireMutex(commitmentId);

    try {
      let summary = this.summaries.get(commitmentId);
      if (!summary) {
        throw new AllocationValidationError([
          `ALLOCATION_NOT_FOUND: No allocation calculated for commitment '${commitmentId}'`,
        ]);
      }

      // If already finalized, return idempotent state
      if (summary.status === 'FINALIZED') {
        const ledgerEntries = this.ledgerService.getAllEntriesForCommitment(commitmentId);
        const reconciliation = this.reconService.getReconciliationResult(commitmentId)!;
        return { summary, ledgerEntries, reconciliation };
      }

      // Auto-validate if currently CALCULATED
      if (summary.status === 'CALCULATED') {
        summary = this.validateAllocation(commitmentId);
      }

      assertLegalAllocationTransition(summary.status, 'FINALIZED');

      const now = new Date();
      summary.status = 'FINALIZED';
      summary.finalizedAt = now;

      // 1. Advance allocation records to FINALIZED
      for (const alloc of summary.allocations) {
        alloc.allocationStatus = 'FINALIZED';
        alloc.finalizedAt = now;
        alloc.updatedAt = now;
      }

      // 2. Post immutable ledger entries for every resident allocation
      const ledgerEntries: ResidentLedgerEntry[] = [];
      for (const alloc of summary.allocations) {
        const entry = this.ledgerService.postAllocation(alloc);
        ledgerEntries.push(entry);
      }

      // 3. Execute Authoritative 4-Pillar Reconciliation
      const commitment = this.commitments.get(commitmentId)!;
      const fulfillments = this.fulfillmentsByCommitment.get(commitmentId) || [];

      const reconciliation = this.reconService.reconcileCommitment({
        commitment,
        fulfillments,
        allocations: summary.allocations,
        payments,
        purchaseOrders,
      });

      // Update reconciliation status on summary and allocations
      summary.reconciliationStatus = reconciliation.status;
      for (const alloc of summary.allocations) {
        alloc.reconciliationStatus = reconciliation.status;
      }

      this.auditService.emit('ALLOCATION_FINALIZED', commitmentId, {
        commitmentId,
        residentCount: summary.residentCount,
        reconciliationStatus: reconciliation.status,
      });

      return { summary, ledgerEntries, reconciliation };
    } finally {
      this.releaseMutex(commitmentId);
    }
  }

  /**
   * Retrieves resident allocations with server-side authorization check.
   */
  public getResidentAllocations(
    residentReference: string,
    requestingResidentReference: string
  ): ResidentAllocation[] {
    validateResidentAuthorization(requestingResidentReference, residentReference);
    return this.allocationsByResident.get(residentReference) || [];
  }

  /**
   * Retrieves commitment-wide allocation summary.
   */
  public getCommitmentAllocationSummary(
    commitmentId: string
  ): ResidentAllocationSummary | undefined {
    return this.summaries.get(commitmentId);
  }

  /**
   * Authoritative, non-hallucinated resident-facing breakdown of an allocation.
   */
  public explainAllocation(
    residentOrderId: string,
    requestingResidentReference: string
  ): AllocationExplanation {
    const alloc = this.allocationsByOrder.get(residentOrderId);
    if (!alloc) {
      throw new AllocationValidationError([
        `ALLOCATION_NOT_FOUND: No allocation found for resident order '${residentOrderId}'`,
      ]);
    }

    // Server-side authorization check
    validateResidentAuthorization(requestingResidentReference, alloc.residentReference);

    const fulfillments = this.fulfillmentsByCommitment.get(alloc.commitmentId) || [];
    const verifiedFulfilledQuantity = fulfillments.reduce(
      (s, f) => s + f.fulfilledQuantity,
      0
    );

    const isPartial = alloc.allocatedQuantity < alloc.requestedQuantity;
    const policyDesc = isPartial
      ? 'Proportional scarcity distribution using Hamilton-Hare largest-remainder whole-unit allocation.'
      : 'Full fulfillment matching 100% of resident requested quantity.';

    const summaryText = isPartial
      ? `Requested ${alloc.requestedQuantity} ${alloc.unit}, allocated ${alloc.allocatedQuantity} ${alloc.unit} due to partial supplier delivery (${verifiedFulfilledQuantity} total verified units). Net payable is ₹${alloc.totalAmount}.`
      : `Requested ${alloc.requestedQuantity} ${alloc.unit}, fully fulfilled ${alloc.allocatedQuantity} ${alloc.unit}. Net payable is ₹${alloc.totalAmount}.`;

    return {
      residentOrderId: alloc.residentOrderId,
      demandLineId: alloc.demandLineId,
      residentReference: alloc.residentReference,
      productName: alloc.productName,
      requestedQuantity: alloc.requestedQuantity,
      verifiedFulfilledQuantity,
      allocatedQuantity: alloc.allocatedQuantity,
      unit: alloc.unit,
      unitPrice: alloc.unitPrice,
      subtotal: alloc.subtotal,
      allocatedTax: alloc.allocatedTax,
      allocatedDeliveryFee: alloc.allocatedDeliveryFee,
      allocatedOtherCharges: alloc.allocatedOtherCharges,
      totalAmount: alloc.totalAmount,
      allocationPolicy: policyDesc,
      status: alloc.allocationStatus,
      reconciliationStatus: alloc.reconciliationStatus,
      explanationSummary: summaryText,
    };
  }

  private async acquireMutex(key: string): Promise<void> {
    while (this.mutexes.has(key)) {
      await this.mutexes.get(key);
    }
    let resolver: () => void;
    const promise = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    (promise as any)._resolver = resolver!;
    this.mutexes.set(key, promise);
  }

  private releaseMutex(key: string): void {
    const promise = this.mutexes.get(key);
    if (promise) {
      this.mutexes.delete(key);
      const resolver = (promise as any)._resolver;
      if (resolver) resolver();
    }
  }
}

export const allocationService = new AllocationService();
