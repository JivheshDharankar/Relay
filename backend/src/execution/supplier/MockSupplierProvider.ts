import { randomUUID } from 'crypto';
import { SupplierAdapter, SupplierAdapterError } from './SupplierAdapter';
import {
  SupplierPurchaseOrderRequest,
  SupplierPurchaseOrderResponse,
} from './types';

export interface MockSupplierConfig {
  mode?: 'confirm' | 'reject';
  rejectionCode?: string;
  rejectionReason?: string;
  turnaroundHours?: number;
}

export class MockSupplierProvider implements SupplierAdapter {
  public readonly providerName = 'mock-supplier';
  private config: MockSupplierConfig;
  private ordersByReference = new Map<string, SupplierPurchaseOrderResponse>();
  private idempotencyStore = new Map<string, SupplierPurchaseOrderResponse>();

  constructor(config?: MockSupplierConfig) {
    this.config = config ?? { mode: 'confirm', turnaroundHours: 6 };
  }

  public setMode(mode: 'confirm' | 'reject', options?: { rejectionCode?: string; rejectionReason?: string }): void {
    this.config.mode = mode;
    if (options?.rejectionCode) this.config.rejectionCode = options.rejectionCode;
    if (options?.rejectionReason) this.config.rejectionReason = options.rejectionReason;
  }

  public reset(): void {
    this.config = { mode: 'confirm', turnaroundHours: 6 };
    this.ordersByReference.clear();
    this.idempotencyStore.clear();
  }

  public async submitPurchaseOrder(po: SupplierPurchaseOrderRequest): Promise<SupplierPurchaseOrderResponse> {
    // 1. Idempotency Check
    const idempKey = po.idempotencyKey || `PO-COMM-${po.communityOrderId}`;
    if (this.idempotencyStore.has(idempKey)) {
      const existing = this.idempotencyStore.get(idempKey)!;
      return {
        ...existing,
        isDuplicate: true,
      };
    }

    const totalAmount = po.items.reduce((sum, item) => sum + item.totalPrice, 0);
    const poReference = `MOCK-PO-${randomUUID().slice(0, 8).toUpperCase()}`;

    // 2. Rejection Mode Simulation
    if (this.config.mode === 'reject') {
      const rejectedResponse: SupplierPurchaseOrderResponse = {
        success: false,
        poReference,
        supplierId: po.supplierId,
        status: 'REJECTED',
        confirmedDeliveryEta: po.deliveryDeadline,
        totalAmount,
        currency: 'INR',
        failureCode: this.config.rejectionCode ?? 'SUPPLIER_REJECTED_ORDER',
        failureReason: this.config.rejectionReason ?? 'Supplier inventory capacity exceeded for this slot.',
        isDuplicate: false,
      };

      this.idempotencyStore.set(idempKey, rejectedResponse);
      this.ordersByReference.set(poReference, rejectedResponse);
      return rejectedResponse;
    }

    // 3. Confirm Mode: Assign realistic delivery ETA <= 12 hours from now
    const turnaroundMs = (this.config.turnaroundHours ?? 6) * 3600 * 1000;
    const confirmedDeliveryEta = new Date(Date.now() + turnaroundMs);

    const confirmedResponse: SupplierPurchaseOrderResponse = {
      success: true,
      poReference,
      supplierId: po.supplierId,
      status: 'CONFIRMED',
      confirmedDeliveryEta,
      totalAmount,
      currency: 'INR',
      isDuplicate: false,
    };

    this.idempotencyStore.set(idempKey, confirmedResponse);
    this.ordersByReference.set(poReference, confirmedResponse);

    return confirmedResponse;
  }

  public async confirmOrder(poReference: string): Promise<SupplierPurchaseOrderResponse> {
    const existing = this.ordersByReference.get(poReference);
    if (!existing) {
      throw new SupplierAdapterError(
        'PURCHASE_ORDER_NOT_FOUND',
        `No purchase order found for reference '${poReference}'`
      );
    }

    existing.status = 'PREPARING';
    return existing;
  }

  public async getOrderStatus(poReference: string): Promise<SupplierPurchaseOrderResponse> {
    const existing = this.ordersByReference.get(poReference);
    if (!existing) {
      throw new SupplierAdapterError(
        'PURCHASE_ORDER_NOT_FOUND',
        `No purchase order found for reference '${poReference}'`
      );
    }
    return existing;
  }
}

export const mockSupplierProvider = new MockSupplierProvider();

