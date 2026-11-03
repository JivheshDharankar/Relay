import { randomUUID } from 'crypto';
import { PaymentExecutionRequest, PaymentProviderResult } from '../types';
import { PaymentProvider } from './PaymentProvider';

export interface MockSimulationOverride {
  type: 'FAILURE' | 'TIMEOUT' | 'NETWORK_ERROR';
  failureCode?: string;
  failureReason?: string;
  isRetryable?: boolean;
}

export class MockPaymentProvider implements PaymentProvider {
  public readonly providerName = 'MockPaymentProvider';
  public readonly isSimulated = true;

  private idempotencyCache = new Map<string, PaymentProviderResult>();
  private simulationOverrides = new Map<string, MockSimulationOverride>();
  private globalFailureMode?: MockSimulationOverride;

  public async authorizeAndCapture(
    request: PaymentExecutionRequest
  ): Promise<PaymentProviderResult> {
    const startTime = Date.now();
    const dedupeKey = request.idempotencyKey || `tx_${request.paymentId}`;

    // 1. Idempotency Check
    if (this.idempotencyCache.has(dedupeKey)) {
      const cached = this.idempotencyCache.get(dedupeKey)!;
      return {
        ...cached,
        metadata: {
          ...cached.metadata,
          isDuplicate: true,
        },
      };
    }

    // 2. Check for configured failure or timeout simulation
    const override =
      this.simulationOverrides.get(request.paymentId) ||
      this.simulationOverrides.get(request.purchaseOrderId) ||
      this.simulationOverrides.get(request.supplierId) ||
      this.simulationOverrides.get(request.idempotencyKey) ||
      this.globalFailureMode;

    if (override) {
      if (override.type === 'TIMEOUT') {
        const timeoutResult: PaymentProviderResult = {
          status: 'TIMEOUT',
          providerTransactionId: `tx_timeout_${randomUUID().slice(0, 8)}`,
          providerName: this.providerName,
          failureCode: 'PROVIDER_TIMEOUT',
          failureReason: 'Mock payment gateway connection timed out after 30000ms',
          isRetryable: true,
          processedAt: new Date(),
          metadata: {
            isSimulated: true,
            simulatedError: 'TIMEOUT',
            durationMs: Date.now() - startTime,
          },
        };
        this.idempotencyCache.set(dedupeKey, timeoutResult);
        return timeoutResult;
      }

      if (override.type === 'NETWORK_ERROR') {
        const networkErrorResult: PaymentProviderResult = {
          status: 'FAILED',
          providerTransactionId: `tx_net_err_${randomUUID().slice(0, 8)}`,
          providerName: this.providerName,
          failureCode: 'NETWORK_ERROR',
          failureReason: 'Mock network connection reset by peer during capture',
          isRetryable: true,
          processedAt: new Date(),
          metadata: {
            isSimulated: true,
            simulatedError: 'NETWORK_ERROR',
            durationMs: Date.now() - startTime,
          },
        };
        this.idempotencyCache.set(dedupeKey, networkErrorResult);
        return networkErrorResult;
      }

      if (override.type === 'FAILURE') {
        const failureResult: PaymentProviderResult = {
          status: 'FAILED',
          providerTransactionId: `tx_fail_${randomUUID().slice(0, 8)}`,
          providerName: this.providerName,
          failureCode: override.failureCode || 'GATEWAY_DECLINED',
          failureReason:
            override.failureReason || 'Simulated provider transaction decline',
          isRetryable: override.isRetryable ?? false,
          processedAt: new Date(),
          metadata: {
            isSimulated: true,
            simulatedError: 'FAILURE',
            durationMs: Date.now() - startTime,
          },
        };
        this.idempotencyCache.set(dedupeKey, failureResult);
        return failureResult;
      }
    }

    // 3. Normal Deterministic Simulation Success
    const successResult: PaymentProviderResult = {
      status: 'SUCCESS',
      providerTransactionId: `tx_mock_${randomUUID().slice(0, 10)}`,
      providerName: this.providerName,
      isRetryable: false,
      processedAt: new Date(),
      metadata: {
        isSimulated: true,
        simulationNotice: 'Simulated payment transaction; zero real money moved.',
        amount: request.amount,
        currency: request.currency,
        recipient: request.recipientReference,
        durationMs: Date.now() - startTime,
      },
    };

    this.idempotencyCache.set(dedupeKey, successResult);
    return successResult;
  }

  // Simulation controls for testing & resilience verification
  public simulateFailure(
    key: string,
    failureCode = 'GATEWAY_DECLINED',
    failureReason = 'Payment provider declined transaction',
    isRetryable = false
  ): void {
    this.simulationOverrides.set(key, {
      type: 'FAILURE',
      failureCode,
      failureReason,
      isRetryable,
    });
  }

  public simulateTimeout(key: string): void {
    this.simulationOverrides.set(key, {
      type: 'TIMEOUT',
      isRetryable: true,
    });
  }

  public simulateNetworkError(key: string): void {
    this.simulationOverrides.set(key, {
      type: 'NETWORK_ERROR',
      isRetryable: true,
    });
  }

  public setGlobalFailure(override?: MockSimulationOverride): void {
    this.globalFailureMode = override;
  }

  public clearOverrides(): void {
    this.simulationOverrides.clear();
    this.globalFailureMode = undefined;
  }

  public reset(): void {
    this.idempotencyCache.clear();
    this.simulationOverrides.clear();
    this.globalFailureMode = undefined;
  }
}

export const mockPaymentProvider = new MockPaymentProvider();
