import {
  PaymentExecutionRequest,
  PaymentExecutionResponse,
  RefundRequest,
  RefundResponse,
} from './types';

export class PaymentAdapterError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'PaymentAdapterError';
    this.code = code;
    this.details = details;
  }
}

export interface PaymentAdapter {
  readonly providerName: string;

  /**
   * Executes a payment for an already-authorized resident procurement amount.
   * NEVER decides authorization limits itself — that is enforced by the deterministic core.
   */
  execute(request: PaymentExecutionRequest): Promise<PaymentExecutionResponse>;

  /**
   * Retrieves operational payment status from the provider by reference.
   */
  getStatus(providerReference: string): Promise<PaymentExecutionResponse>;

  /**
   * Processes a refund for an existing payment.
   */
  refund(request: RefundRequest): Promise<RefundResponse>;
}

