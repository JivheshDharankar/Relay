/**
 * Shared type definitions for the Relay frontend.
 * Mirrors the frozen backend contracts (docs/frontend-contracts.md).
 */

export interface SystemHealth {
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

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// ---------------------------------------------------------------------------
// AGENT & WORKFLOW TYPES
// ---------------------------------------------------------------------------

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

export interface AgentStep {
  stepNumber: number;
  thought?: string;
  toolCall?: AgentToolCall;
  timestamp: string;
}

export interface AgentRunRequest {
  message: string;
  residentId?: string;
  societyId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentRunResponse {
  success: boolean;
  completed: boolean;
  runId: string;
  totalSteps: number;
  response: string;
  steps: AgentStep[];
  error?: {
    code: string;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// PORTAL & DOMAIN ENTITY TYPES
// ---------------------------------------------------------------------------

export interface ResidentProfile {
  id: string;
  name: string;
  email: string;
  flatNumber: string | null;
  societyId: string;
  societyName: string;
  societyAddress: string;
  societyCity: string;
  activeMandate: {
    id: string;
    maximumAmount: number;
    currency: string;
    status: string;
  } | null;
  totalOrders: number;
}

export interface OrderItemSummary {
  id: string;
  productId: string;
  productName: string;
  category: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  totalPrice: number;
}

export interface PortalOrder {
  id: string;
  status: string;
  totalAmount: number;
  currency: string;
  deliveryAddress: string;
  requestedAt: string;
  items: OrderItemSummary[];
  payment: {
    id: string;
    status: string;
    amount: number;
    providerReference: string | null;
    createdAt: string;
  } | null;
  communityOrder: {
    id: string;
    status: string;
    supplierName: string;
    deliveryStatus: string;
    trackingCode: string | null;
  } | null;
}

export interface DemandPool {
  productId: string;
  productName: string;
  totalQuantity: number;
  unit: string;
  contributingOrdersCount: number;
  estimatedSavingsPct: number;
}

export interface CommunityData {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  verified: boolean;
  totalFlatsRepresentation: number;
  registeredResidents: number;
  verifiedSuppliersCount: number;
  totalCommunityOrders: number;
  activeDemandPools: DemandPool[];
  collectiveSavingsEstimatePct: number;
}

export interface PaymentTransaction {
  id: string;
  status: string;
  amount: number;
  currency: string;
  providerReference: string | null;
  failureCode: string | null;
  executedAt: string;
  orderId: string;
  itemDescription: string;
}

export interface MandateLimitUpdate {
  id: string;
  maximumAmount: number;
  spentAmount: number;
  reservedAmount: number;
  remainingLimit: number;
  currency: string;
  status: string;
}

export interface PaymentSummary {
  mandate: {
    id: string;
    maximumAmount: number;
    currency: string;
    status: string;
    authorizedAt: string;
    usedAmount: number;
    remainingLimit: number;
    autoExecutionEnabled: boolean;
  } | null;
  transactions: PaymentTransaction[];
}

export interface VerifiedSupplier {
  id: string;
  name: string;
  city: string;
  rating: number;
  reliabilityScorePct: number;
  serviceRadiusKm: number;
  slaHours: number;
  catalog: {
    productId: string;
    name: string;
    category: string;
    unit: string;
    basePrice: number;
    moq: number;
  }[];
}

// ---------------------------------------------------------------------------
// EXECUTION & DELIVERY TYPES
// ---------------------------------------------------------------------------

export interface DeliverySnapshot {
  deliveryId: string;
  communityOrderId: string;
  status: 'PENDING' | 'PREPARING' | 'DISPATCHED' | 'OUT_FOR_DELIVERY' | 'DELIVERED';
  trackingCode?: string;
  dispatchedAt?: string;
  deliveredAt?: string;
  updatedAt: string;
}

export interface ReconciliationReport {
  isReconciled: boolean;
  communityOrderId: string;
  status: 'RECONCILED' | 'FAILED';
  quantityReconciliation: {
    passed: boolean;
    communityTotal: number | string;
    residentSum: number | string;
    difference: number | string;
  };
  financialReconciliation: {
    passed: boolean;
    communityTotal: number | string;
    residentSum: number | string;
    difference: number | string;
  };
  productIntegrity: { passed: boolean; discrepancies: string[] };
  societyIntegrity: { passed: boolean; societyId: string };
  discrepancies: string[];
}
