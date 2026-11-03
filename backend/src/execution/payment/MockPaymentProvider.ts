import { randomUUID } from 'crypto';
import { PaymentStatus } from '@prisma/client';
import { PaymentAdapter, PaymentAdapterError } from './PaymentAdapter';
import {
  PaymentExecutionRequest,
  PaymentExecutionResponse,
  RefundRequest,
  RefundResponse,
} from './types';

export interface MockPaymentConfig {
  mode?: 'success' | 'failure';
  failureCode?: string;
  failureReason?: string;
  simulateUnavailable?: boolean;
}

export class MockPaymentProvider implements PaymentAdapter {
  public readonly providerName = 'mock-payment';
  private config: MockPaymentConfig;
  private processedPayments = new Map<string, PaymentExecutionResponse>();
  private idempotencyStore = new Map<string, PaymentExecutionResponse>();

  constructor(config?: MockPaymentConfig) {
    this.config = config ?? { mode: 'success' };
  }

  public setMode(mode: 'success' | 'failure', options?: { failureCode?: string; failureReason?: string }): void {
    this.config.mode = mode;
    if (options?.failureCode) this.config.failureCode = options.failureCode;
    if (options?.failureReason) this.config.failureReason = options.failureReason;
  }

  public setUnavailable(unavailable: boolean): void {
    this.config.simulateUnavailable = unavailable;
  }

  public reset(): void {
    this.config = { mode: 'success' };
    this.processedPayments.clear();
    this.idempotencyStore.clear();
  }

  public async execute(request: PaymentExecutionRequest): Promise<PaymentExecutionResponse> {
    // 1. Simulate provider downtime if configured
    if (this.config.simulateUnavailable) {
      throw new PaymentAdapterError(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        'Mock payment provider is temporarily unavailable for processing.'
      );
    }

    // 2. Idempotency check: Return existing result for identical idempotency key
    if (request.idempotencyKey && this.idempotencyStore.has(request.idempotencyKey)) {
      const existing = this.idempotencyStore.get(request.idempotencyKey)!;
      return {
        ...existing,
        isDuplicate: true,
      };
    }

    const amountNum = typeof request.amount === 'number' ? request.amount : Number(request.amount);
    const executedAt = new Date();
    const paymentId = randomUUID();
    const providerReference = `MOCK-TXN-${randomUUID().slice(0, 8).toUpperCase()}`;

    // 3. Failure simulation
    if (this.config.mode === 'failure') {
      const failedResponse: PaymentExecutionResponse = {
        success: false,
        paymentId,
        providerReference,
        status: PaymentStatus.FAILED,
        amount: amountNum,
        currency: request.currency ?? 'INR',
        failureCode: this.config.failureCode ?? 'PAYMENT_EXECUTION_FAILED',
        failureReason: this.config.failureReason ?? 'Simulated payment processing failure.',
        executedAt,
        isDuplicate: false,
      };

      if (request.idempotencyKey) {
        this.idempotencyStore.set(request.idempotencyKey, failedResponse);
      }
      this.processedPayments.set(providerReference, failedResponse);

      return failedResponse;
    }

    // 4. Success path
    const successResponse: PaymentExecutionResponse = {
      success: true,
      paymentId,
      providerReference,
      status: PaymentStatus.SUCCESS,
      amount: amountNum,
      currency: request.currency ?? 'INR',
      executedAt,
      isDuplicate: false,
    };

    if (request.idempotencyKey) {
      this.idempotencyStore.set(request.idempotencyKey, successResponse);
    }
    this.processedPayments.set(providerReference, successResponse);

    return successResponse;
  }

  public async getStatus(providerReference: string): Promise<PaymentExecutionResponse> {
    const existing = this.processedPayments.get(providerReference);
    if (!existing) {
      throw new PaymentAdapterError(
        'PAYMENT_NOT_FOUND',
        `No payment found with provider reference '${providerReference}'`
      );
    }
    return existing;
  }

  public async refund(request: RefundRequest): Promise<RefundResponse> {
    return {
      success: true,
      refundReference: `MOCK-REFUND-${randomUUID().slice(0, 8).toUpperCase()}`,
      amount: request.amount ?? 0,
      status: PaymentStatus.REFUNDED,
    };
  }
}

export const mockPaymentProvider = new MockPaymentProvider();

