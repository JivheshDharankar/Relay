import { randomUUID } from 'crypto';
import {
  NegotiationDispatchRequest,
  NegotiationDispatchResponse,
  RFQDispatchRequest,
  RFQDispatchResponse,
  SupplierContactProvider,
} from './types';
import {
  SupplierContactError,
  SupplierContactErrorCode,
} from './SupplierContactProvider';

export interface MockContactProviderConfig {
  mode?: 'success' | 'timeout' | 'error';
  errorCode?: SupplierContactErrorCode;
  errorMessage?: string;
  statusCode?: number;
}

/**
 * Deterministic test/development supplier contact provider.
 * Never calls external APIs, never sends real emails, and records all dispatched messages for verification.
 */
export class MockSupplierContactProvider implements SupplierContactProvider {
  public readonly providerName = 'mock';
  private config: MockContactProviderConfig;
  public sentDispatches: RFQDispatchRequest[] = [];
  public sentNegotiations: NegotiationDispatchRequest[] = [];

  constructor(config?: MockContactProviderConfig) {
    this.config = config ?? { mode: 'success' };
  }

  public setMode(
    mode: 'success' | 'timeout' | 'error',
    options?: { errorCode?: SupplierContactErrorCode; errorMessage?: string; statusCode?: number }
  ): void {
    this.config.mode = mode;
    if (options?.errorCode) this.config.errorCode = options.errorCode;
    if (options?.errorMessage) this.config.errorMessage = options.errorMessage;
    if (options?.statusCode) this.config.statusCode = options.statusCode;
  }

  public reset(): void {
    this.config = { mode: 'success' };
    this.sentDispatches = [];
    this.sentNegotiations = [];
  }

  public async sendRFQ(request: RFQDispatchRequest): Promise<RFQDispatchResponse> {
    if (this.config.mode === 'timeout') {
      throw new SupplierContactError(
        'REQUEST_TIMEOUT',
        'Mock contact provider simulated timeout'
      );
    }

    if (this.config.mode === 'error') {
      throw new SupplierContactError(
        this.config.errorCode ?? 'PROVIDER_ERROR',
        this.config.errorMessage ?? 'Mock contact provider simulated error',
        this.config.statusCode ?? 500
      );
    }

    const recipient =
      request.rfq.recipientContact ||
      request.rfq.candidate.email ||
      request.rfq.candidate.phone ||
      'mock-recipient';

    this.sentDispatches.push(request);

    return {
      success: true,
      messageId: `mock_msg_${randomUUID().slice(0, 8)}`,
      dispatchedAt: new Date(),
      providerName: this.providerName,
      recipient,
      metadata: { mockDispatchCount: this.sentDispatches.length },
    };
  }

  public async sendNegotiation(
    request: NegotiationDispatchRequest
  ): Promise<NegotiationDispatchResponse> {
    if (this.config.mode === 'timeout') {
      throw new SupplierContactError(
        'REQUEST_TIMEOUT',
        'Mock contact provider simulated timeout'
      );
    }

    if (this.config.mode === 'error') {
      throw new SupplierContactError(
        this.config.errorCode ?? 'PROVIDER_ERROR',
        this.config.errorMessage ?? 'Mock contact provider simulated error',
        this.config.statusCode ?? 500
      );
    }

    const recipient =
      request.recipientEmail ||
      'mock-negotiation-recipient@supplier.com';

    this.sentNegotiations.push(request);

    return {
      success: true,
      messageId: `mock_nego_${randomUUID().slice(0, 8)}`,
      dispatchedAt: new Date(),
      providerName: this.providerName,
      recipient,
      metadata: { mockNegotiationCount: this.sentNegotiations.length },
    };
  }
}

export const mockSupplierContactProvider = new MockSupplierContactProvider();

