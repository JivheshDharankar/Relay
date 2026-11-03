export interface SupplierPurchaseOrderItem {
  productId: string;
  productName: string;
  quantity: number;
  unit: string;
  negotiatedUnitPrice: number;
  totalPrice: number;
}

export interface SupplierPurchaseOrderRequest {
  communityOrderId: string;
  societyId: string;
  societyName: string;
  deliveryAddress: string;
  supplierId: string;
  deliveryDeadline: Date;
  idempotencyKey?: string;
  items: SupplierPurchaseOrderItem[];
}

export type SupplierOrderStatus = 'SUBMITTED' | 'CONFIRMED' | 'PREPARING' | 'DISPATCHED' | 'REJECTED';

export interface SupplierPurchaseOrderResponse {
  success: boolean;
  poReference: string;
  supplierId: string;
  status: SupplierOrderStatus;
  confirmedDeliveryEta: Date;
  totalAmount: number;
  currency: string;
  failureCode?: string;
  failureReason?: string;
  isDuplicate?: boolean;
}

