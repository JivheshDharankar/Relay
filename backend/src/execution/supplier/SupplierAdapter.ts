import {
  SupplierPurchaseOrderRequest,
  SupplierPurchaseOrderResponse,
} from './types';

export class SupplierAdapterError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'SupplierAdapterError';
    this.code = code;
    this.details = details;
  }
}

export interface SupplierAdapter {
  readonly providerName: string;

  /**
   * Submits an anonymized bulk purchase order to the selected local supplier.
   * NEVER receives individual resident PII or unit breakdown.
   */
  submitPurchaseOrder(po: SupplierPurchaseOrderRequest): Promise<SupplierPurchaseOrderResponse>;

  /**
   * Confirms supplier acceptance and estimated fulfillment turnaround within 12h SLA.
   */
  confirmOrder(poReference: string): Promise<SupplierPurchaseOrderResponse>;

  /**
   * Retrieves live operational order status from the supplier.
   */
  getOrderStatus(poReference: string): Promise<SupplierPurchaseOrderResponse>;
}

