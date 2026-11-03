export * from './errors';
export * from './procurement';

// Re-export Prisma client enums for convenient, centralized domain typing
export {
  ResidentStatus,
  SupplierStatus,
  ProductUnit,
  ResidentOrderStatus,
  CommunityOrderStatus,
  SupplierOfferStatus,
  NegotiationStatus,
  PaymentMandateStatus,
  PaymentStatus,
  DeliveryStatus,
  DeliveryAllocationStatus,
  AuditEventType,
} from '@prisma/client';

export type {
  Society,
  Resident,
  Supplier,
  Product,
  ResidentOrder,
  OrderItem,
  CommunityOrder,
  CommunityOrderItem,
  SupplierOffer,
  Negotiation,
  NegotiationRound,
  PaymentMandate,
  Payment,
  Delivery,
  DeliveryAllocation,
  AuditEvent,
} from '@prisma/client';

/**
 * Foundational health domain model
 */
export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  uptimeSeconds: number;
  environment: string;
  version: string;
  database: {
    status: 'connected' | 'disconnected';
    latencyMs?: number;
    error?: string;
  };
}
