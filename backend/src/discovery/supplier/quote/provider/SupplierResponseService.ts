import { randomUUID } from 'crypto';
import { eventBus } from '../../../../events';
import { RFQService } from '../../rfq/RFQService';
import { SupplierResponse } from '../types';
import { EmailSupplierResponseProvider } from './EmailSupplierResponseProvider';
import { MockSupplierResponseProvider } from './MockSupplierResponseProvider';
import { SupplierResponseError } from './SupplierResponseProvider';
import { IngestResponseInput, SupplierResponseProvider } from './types';

export class SupplierResponseService {
  private providers = new Map<string, SupplierResponseProvider>();
  private responses = new Map<string, SupplierResponse>();
  private idempotencyStore = new Map<string, SupplierResponse>();
  private inFlightIngestions = new Map<string, Promise<SupplierResponse>>();

  constructor(rfqServiceInstance?: RFQService) {
    const mockProvider = new MockSupplierResponseProvider(rfqServiceInstance);
    this.registerProvider(mockProvider);
    this.registerProvider(new EmailSupplierResponseProvider(rfqServiceInstance));

    // Support other transport channels via provider registration
    this.providers.set('portal', mockProvider);
    this.providers.set('api', mockProvider);
    this.providers.set('webhook', mockProvider);
  }

  public registerProvider(provider: SupplierResponseProvider): void {
    this.providers.set(provider.channel, provider);
  }

  public getProvider(channel: string): SupplierResponseProvider {
    const provider = this.providers.get(channel);
    if (!provider) {
      throw new SupplierResponseError(
        'PROVIDER_ERROR',
        `No response provider registered for channel '${channel}'`
      );
    }
    return provider;
  }

  /**
   * Ingests a supplier response payload, enforcing deduplication, RFQ consistency, and audit emission.
   */
  public async ingestResponse(input: IngestResponseInput): Promise<SupplierResponse> {
    const dedupeKey =
      input.idempotencyKey ||
      (input.providerMessageId ? `msg_${input.rfqId}_${input.providerMessageId}` : undefined);

    // 1. Idempotency Check
    if (dedupeKey && this.idempotencyStore.has(dedupeKey)) {
      return this.idempotencyStore.get(dedupeKey)!;
    }

    // 2. Concurrency Guard
    if (dedupeKey && this.inFlightIngestions.has(dedupeKey)) {
      return this.inFlightIngestions.get(dedupeKey)!;
    }

    const provider = this.getProvider(input.channel || 'manual');

    const ingestPromise = (async () => {
      try {
        const response = await provider.ingest(input);

        this.responses.set(response.id, response);
        if (dedupeKey) {
          this.idempotencyStore.set(dedupeKey, response);
        }

        // Publish audit event
        eventBus.publish({
          id: randomUUID(),
          name: 'SUPPLIER_RESPONSE_RECEIVED',
          aggregateId: response.id,
          timestamp: response.receivedAt.toISOString(),
          payload: {
            responseId: response.id,
            rfqId: response.rfqId,
            candidateId: response.candidateId,
            channel: response.channel,
            itemCount: response.lineItems.length,
          },
        }).catch(() => {});

        return response;
      } finally {
        if (dedupeKey) {
          this.inFlightIngestions.delete(dedupeKey);
        }
      }
    })();

    if (dedupeKey) {
      this.inFlightIngestions.set(dedupeKey, ingestPromise);
    }

    return ingestPromise;
  }

  public getResponse(id: string): SupplierResponse | undefined {
    return this.responses.get(id);
  }

  public listResponses(): SupplierResponse[] {
    return Array.from(this.responses.values());
  }

  public reset(): void {
    this.responses.clear();
    this.idempotencyStore.clear();
    this.inFlightIngestions.clear();
  }
}

export const supplierResponseService = new SupplierResponseService();
