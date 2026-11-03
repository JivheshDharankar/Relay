import { CommunityOrderStatus, ResidentOrderStatus } from '@prisma/client';
import { PaymentExecutionResponse } from './payment/types';
import { SupplierPurchaseOrderResponse } from './supplier/types';
import { DeliveryStateSnapshot } from './delivery/types';
import { ReconciliationReport } from '../domain/procurement';

export class ExecutionError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
    this.details = details;
  }
}

export interface ExecutePaymentInput {
  residentOrderId: string;
  paymentMandateId?: string;
  amount?: number;
  idempotencyKey?: string;
  purpose?: string;
  /**
   * Server-resolved payer identity. When set, the order must belong to this
   * resident or execution is refused (fail-closed cross-user protection).
   */
  expectedResidentId?: string;
}

export interface ExecutePaymentResult {
  success: boolean;
  payment: PaymentExecutionResponse;
  orderId: string;
  residentOrderStatus: ResidentOrderStatus;
}

export interface ExecuteSupplierOrderInput {
  communityOrderId: string;
  idempotencyKey?: string;
}

export interface ExecuteSupplierOrderResult {
  success: boolean;
  communityOrderId: string;
  po: SupplierPurchaseOrderResponse;
  status: CommunityOrderStatus;
}

export interface ExecuteFullCycleInput {
  communityOrderId: string;
  allocations?: {
    residentOrderId: string;
    productId: string;
    quantity: number | string;
  }[];
}

export interface ExecuteFullCycleResult {
  success: boolean;
  communityOrderId: string;
  payments: ExecutePaymentResult[];
  supplierPO: SupplierPurchaseOrderResponse;
  delivery: DeliveryStateSnapshot;
  reconciliation: ReconciliationReport;
}
