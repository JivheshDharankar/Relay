import { RFQ } from '../types';

/**
 * Payload passed to a supplier contact provider to dispatch an RFQ.
 */
export interface RFQDispatchRequest {
  rfq: RFQ;
  idempotencyKey: string;
}

/**
 * Standard response returned by any supplier contact provider.
 */
export interface RFQDispatchResponse {
  success: boolean;
  messageId: string;
  dispatchedAt: Date;
  providerName: string;
  recipient: string;
  isDuplicate?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Common abstraction for all supplier contact providers (Email/Resend, WhatsApp, API, Mock).
 * Guarantees that the RFQ domain is never coupled to a specific email/messaging vendor.
 */
export interface SupplierContactProvider {
  readonly providerName: string;

  /**
   * Dispatches an RFQ to the recipient supplier.
   */
  sendRFQ(request: RFQDispatchRequest): Promise<RFQDispatchResponse>;

  /**
   * Dispatches a structured commercial negotiation proposal to the supplier.
   */
  sendNegotiation?(request: NegotiationDispatchRequest): Promise<NegotiationDispatchResponse>;
}

/**
 * Payload passed to a supplier contact provider to dispatch a commercial negotiation proposal.
 */
export interface NegotiationDispatchRequest {
  proposalId: string;
  negotiationId: string;
  roundNumber: number;
  recipientEmail?: string;
  recipientName?: string;
  rfqId: string;
  supplierName: string;
  formattedMessage: string;
  idempotencyKey: string;
}

/**
 * Standard response returned by any supplier contact provider for negotiation dispatches.
 */
export interface NegotiationDispatchResponse {
  success: boolean;
  messageId: string;
  dispatchedAt: Date;
  providerName: string;
  recipient: string;
  isDuplicate?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Configuration options for EmailSupplierContactProvider (Resend).
 */
export interface ResendProviderConfig {
  apiKey?: string;
  fromEmail?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

