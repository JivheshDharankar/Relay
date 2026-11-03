import { randomUUID } from 'crypto';
import { PaymentExecutionRequest, PaymentProviderResult } from '../types';
import { PaymentProvider } from './PaymentProvider';

export class SandboxPaymentProvider implements PaymentProvider {
  public readonly providerName = 'SandboxPaymentProvider';
  public readonly isSimulated = true;

  private idempotencyStore = new Map<string, PaymentProviderResult>();

  public async authorizeAndCapture(
    request: PaymentExecutionRequest
  ): Promise<PaymentProviderResult> {
    const dedupeKey = request.idempotencyKey || `sbx_${request.paymentId}`;

    if (this.idempotencyStore.has(dedupeKey)) {
      const existing = this.idempotencyStore.get(dedupeKey)!;
      return {
        ...existing,
        metadata: { ...existing.metadata, isDuplicate: true },
      };
    }

    // Simulate standard sandbox capture
    const result: PaymentProviderResult = {
      status: 'SUCCESS',
      providerTransactionId: `sbx_tx_${randomUUID().slice(0, 12)}`,
      providerName: this.providerName,
      isRetryable: false,
      processedAt: new Date(),
      metadata: {
        isSimulated: true,
        gatewayMode: 'SANDBOX',
        gatewayReference: `gw_${randomUUID().slice(0, 8)}`,
        settlementStatus: 'PENDING_SETTLEMENT',
      },
    };

    this.idempotencyStore.set(dedupeKey, result);
    return result;
  }

  public reset(): void {
    this.idempotencyStore.clear();
  }
}

export const sandboxPaymentProvider = new SandboxPaymentProvider();

