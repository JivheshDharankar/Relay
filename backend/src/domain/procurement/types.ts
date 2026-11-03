import { Prisma, ProductUnit } from '@prisma/client';

export interface ProcurementRequestInput {
  residentId: string;
  societyId: string;
  productId: string;
  quantity: Prisma.Decimal | number | string;
  unit: ProductUnit;
  // Optional: when omitted, validateRequest derives Flat/society/city from
  // the canonical resident+society records.
  deliveryAddress?: string;
  idempotencyKey?: string;
  requestedDeadline?: Date;
}

export interface ValidatedProcurementRequest {
  residentId: string;
  societyId: string;
  productId: string;
  productName: string;
  quantity: Prisma.Decimal;
  unit: ProductUnit;
  unitPrice: Prisma.Decimal;
  totalPrice: Prisma.Decimal;
  deliveryAddress: string;
  idempotencyKey?: string;
  requestedDeadline?: Date;
}

export interface AuthorizationCheckInput {
  residentId: string;
  societyId: string;
  requestedAmount: Prisma.Decimal | number | string;
  purpose?: string;
  mandateId?: string;
}

export interface AuthorizationResult {
  authorized: boolean;
  code: 'AUTHORIZED' | 'REJECTED';
  mandateId?: string;
  maxAuthorizedAmount?: Prisma.Decimal;
  requestedAmount: Prisma.Decimal;
  reason?: string;
}

export interface ResidentDemandSummary {
  residentId: string;
  residentOrderId: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  totalPrice: Prisma.Decimal;
}

export interface AggregatedDemandGroup {
  societyId: string;
  productId: string;
  productName: string;
  unit: ProductUnit;
  totalQuantity: Prisma.Decimal;
  contributingOrdersCount: number;
  residentDemands: ResidentDemandSummary[];
}

export interface SupplierFacingDemand {
  societyId: string;
  productId: string;
  productName: string;
  unit: ProductUnit;
  totalQuantity: Prisma.Decimal;
  contributingOrdersCount: number;
}

export interface SupplierHardConstraintCheck {
  supplierId: string;
  supplierName: string;
  eligible: boolean;
  reasons: string[];
  distanceKm: number;
  serviceRadiusKm: number;
  moq: Prisma.Decimal;
  requestedQuantity: Prisma.Decimal;
  estimatedDeliveryHours: number;
  maxSlaHours: number;
}

export interface OfferEvaluationScore {
  supplierId: string;
  supplierName: string;
  offerId?: string;
  totalPrice: Prisma.Decimal;
  deliveryHours: number;
  reliabilityScore: number;
  hardConstraintPassed: boolean;
  reasons: string[];
  compositeScore: number;
  breakdown: {
    priceScore: number;
    reliabilityScore: number;
    deliveryScore: number;
  };
}

export interface AllocationItem {
  residentOrderId: string;
  residentId: string;
  productId: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  totalPrice: Prisma.Decimal;
}

export interface ReconciliationReport {
  isReconciled: boolean;
  communityOrderId: string;
  status: 'RECONCILED' | 'FAILED';
  quantityReconciliation: {
    passed: boolean;
    communityTotal: Prisma.Decimal;
    residentSum: Prisma.Decimal;
    difference: Prisma.Decimal;
  };
  financialReconciliation: {
    passed: boolean;
    communityTotal: Prisma.Decimal;
    residentSum: Prisma.Decimal;
    difference: Prisma.Decimal;
  };
  productIntegrity: {
    passed: boolean;
    discrepancies: string[];
  };
  societyIntegrity: {
    passed: boolean;
    societyId: string;
  };
  discrepancies: string[];
}
