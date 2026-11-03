import { SupplierCandidate } from '../types';

/**
 * Standardized line item requested in a Request for Quote (RFQ).
 * Represents consolidated community demand, completely hiding individual resident orders.
 */
export interface RFQLineItem {
  productId?: string;
  productName: string;
  quantity: number;
  unit: string;
  specification?: string;
}

/**
 * Lifecycle status of an RFQ.
 */
export type RFQStatus =
  | 'DRAFT'
  | 'READY'
  | 'DISPATCHING'
  | 'SENT'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

/**
 * Supported supplier contact transmission channels.
 */
export type SupplierContactMethod = 'email' | 'whatsapp' | 'api' | 'manual';

/**
 * Delivery requirements presented to the supplier candidate.
 */
export interface RFQDeliveryRequirement {
  /**
   * Consolidated delivery area / society service area (e.g. "Greenview Residency, Pune").
   * Never contains private flat or resident numbers.
   */
  deliveryArea: string;

  /**
   * Hard delivery SLA deadline.
   */
  deliveryDeadline: Date;

  /**
   * Deadline for the supplier to submit their binding quote.
   */
  quoteDeadline: Date;
}

/**
 * Core Request for Quote (RFQ) domain entity.
 */
export interface RFQ {
  /**
   * Stable, unique RFQ identifier.
   */
  id: string;

  /**
   * Discovered candidate ID.
   */
  candidateId: string;

  /**
   * Supplier or commercial business name.
   */
  supplierName: string;

  /**
   * Selected transmission channel.
   */
  contactMethod: SupplierContactMethod;

  /**
   * Destination address (e.g. supplier's email address or phone).
   */
  recipientContact: string;

  /**
   * Consolidated line items.
   */
  lineItems: RFQLineItem[];

  /**
   * Anonymized delivery requirement.
   */
  deliveryArea: string;

  /**
   * Fulfillment deadline.
   */
  deliveryDeadline: Date;

  /**
   * Quote response deadline.
   */
  quoteDeadline: Date;

  /**
   * Lifecycle status.
   */
  status: RFQStatus;

  /**
   * Idempotency key for preventing duplicate dispatches.
   */
  idempotencyKey: string;

  /**
   * Optional community / society context (for internal aggregation reference only, never leaked to supplier).
   */
  societyId?: string;
  societyName?: string;
  communityOrderId?: string;
  procurementRequestId?: string;

  /**
   * Timestamps and audit tracking.
   */
  createdAt: Date;
  updatedAt: Date;
  sentAt?: Date;
  failureReason?: string;
  dispatchAttempts: number;

  /**
   * Composed reference to the discovered candidate.
   */
  candidate: SupplierCandidate;
}

/**
 * Input structure for generating a new RFQ.
 */
export interface CreateRFQInput {
  candidate: SupplierCandidate;
  lineItems: RFQLineItem[];
  deliveryArea: string;
  deliveryDeadline: Date;
  quoteDeadline: Date;
  contactMethod?: SupplierContactMethod;
  recipientContact?: string;
  idempotencyKey?: string;
  societyId?: string;
  societyName?: string;
  communityOrderId?: string;
  procurementRequestId?: string;
}

/**
 * Result returned upon RFQ dispatch attempt.
 */
export interface RFQDispatchResult {
  rfqId: string;
  status: RFQStatus;
  success: boolean;
  messageId?: string;
  dispatchedAt?: Date;
  providerName: string;
  recipient: string;
  isDuplicate?: boolean;
  failureReason?: string;
}

