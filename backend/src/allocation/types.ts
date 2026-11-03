/**
 * Deterministic lifecycle status of a resident allocation.
 */
export type AllocationStatus =
  | 'PENDING'
  | 'CALCULATED'
  | 'VALIDATED'
  | 'FINALIZED'
  | 'REJECTED';

/**
 * Authoritative lifecycle status of a procurement reconciliation.
 */
export type ReconciliationStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'RECONCILED'
  | 'DISCREPANCY'
  | 'BLOCKED';

/**
 * Ledger entry classification. Append-only; financial records are never silently modified.
 */
export type ResidentLedgerEntryType =
  | 'PROCUREMENT_ALLOCATION'
  | 'ADJUSTMENT'
  | 'REVERSAL';

/**
 * Status of an individual ledger entry.
 */
export type ResidentLedgerEntryStatus =
  | 'POSTED'
  | 'ADJUSTED'
  | 'REVERSED';

/**
 * Authoritative demand submitted by a participating resident for a community procurement.
 */
export interface ResidentDemand {
  residentOrderId: string;
  /**
   * Stable per-line demand key. Required to disambiguate multi-item
   * orders where every line shares one `residentOrderId`. Optional on
   * input for backward compatibility; the allocation pipeline resolves
   * it deterministically (see `demandLineKey.ts`) when absent.
   */
  demandLineId?: string;
  residentId: string;
  residentReference: string;
  productId: string;
  productName: string;
  requestedQuantity: number;
  unit: string;
  maxAuthorizedBudget?: number;
  flatNumber?: string;
}

/**
 * Authoritative allocation of verified fulfilled goods/services to an individual resident.
 */
export interface ResidentAllocation {
  id: string;
  commitmentId: string;
  purchaseOrderId?: string;
  fulfillmentOrderId?: string;
  residentOrderId: string;
  /**
   * Per-line demand key this allocation was joined to. Always populated
   * by `prepareAllocation`; optional only for backward compatibility
   * with previously constructed records.
   */
  demandLineId?: string;
  residentReference: string;
  productId: string;
  productName: string;
  requestedQuantity: number;
  allocatedQuantity: number;
  unit: string;
  unitPrice: number;
  subtotal: number;
  allocatedTax: number;
  allocatedDeliveryFee: number;
  allocatedOtherCharges: number;
  totalAmount: number;
  allocationStatus: AllocationStatus;
  reconciliationStatus: ReconciliationStatus;
  idempotencyKey: string;
  contributingSupplierIds?: string[];
  createdAt: Date;
  updatedAt: Date;
  finalizedAt?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * High-level aggregated summary of a procurement allocation across all participating residents.
 */
export interface ResidentAllocationSummary {
  commitmentId: string;
  totalRequestedQuantity: number;
  totalAllocatedQuantity: number;
  totalProcurementCost: number;
  totalResidentAllocatedAmount: number;
  residentCount: number;
  status: AllocationStatus;
  reconciliationStatus: ReconciliationStatus;
  allocations: ResidentAllocation[];
  calculatedAt: Date;
  finalizedAt?: Date;
  /**
   * True when the allocated commercial basis came from simulated supplier
   * responses. Copied from the parent commitment; marks the basis, not the
   * allocation itself.
   */
  commercialBasisSimulated?: boolean;
}

/**
 * Immutable ledger entry representing accounting attribution to a resident.
 */
export interface ResidentLedgerEntry {
  id: string;
  residentReference: string;
  residentOrderId: string;
  allocationId: string;
  commitmentId: string;
  amount: number;
  currency: string;
  entryType: ResidentLedgerEntryType;
  status: ResidentLedgerEntryStatus;
  referenceEntryId?: string;
  reason?: string;
  createdAt: Date;
}

/**
 * Types of discrepancies discovered during deterministic reconciliation.
 */
export type ReconciliationDiscrepancyType =
  | 'QUANTITY_MISMATCH'
  | 'MONETARY_MISMATCH'
  | 'SUPPLIER_OBLIGATION_MISMATCH'
  | 'PAYMENT_LINKAGE_MISMATCH'
  | 'UNVERIFIED_FULFILLMENT'
  | 'NEGATIVE_VALUE_DETECTED'
  | 'OVER_ALLOCATION_DETECTED';

/**
 * Discrepancy record produced when expected and actual values do not reconcile exactly.
 */
export interface ReconciliationDiscrepancy {
  id: string;
  reconciliationId: string;
  commitmentId: string;
  discrepancyType: ReconciliationDiscrepancyType;
  expectedValue: number | string;
  actualValue: number | string;
  difference: number;
  affectedResidentOrderIds: string[];
  reasonCode: string;
  message: string;
  createdAt: Date;
}

/**
 * Complete outcome of a deterministic reconciliation execution.
 */
export interface ReconciliationResult {
  id: string;
  commitmentId: string;
  status: ReconciliationStatus;
  verifiedFulfilledQuantity: number;
  totalAllocatedQuantity: number;
  authoritativeProcurementAmount: number;
  totalAllocatedResidentAmount: number;
  isQuantityMatched: boolean;
  isMonetaryMatched: boolean;
  isSupplierObligationsMatched: boolean;
  isPaymentVerified: boolean;
  discrepancies: ReconciliationDiscrepancy[];
  reconciledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  /**
   * True when the reconciled commercial basis came from simulated supplier
   * responses (any contributing PO simulated). Marks the basis, not the
   * reconciliation verdict itself.
   */
  commercialBasisSimulated?: boolean;
}

/**
 * Authoritative, non-hallucinated resident-facing breakdown of an allocation.
 */
export interface AllocationExplanation {
  residentOrderId: string;
  demandLineId?: string;
  residentReference: string;
  productName: string;
  requestedQuantity: number;
  verifiedFulfilledQuantity: number;
  allocatedQuantity: number;
  unit: string;
  unitPrice: number;
  subtotal: number;
  allocatedTax: number;
  allocatedDeliveryFee: number;
  allocatedOtherCharges: number;
  totalAmount: number;
  allocationPolicy: string;
  status: AllocationStatus;
  reconciliationStatus: ReconciliationStatus;
  explanationSummary: string;
}
