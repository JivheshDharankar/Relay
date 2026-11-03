import { env } from '../../../../config/env';
import { EmailSupplierContactProvider } from './EmailSupplierContactProvider';
import { mockSupplierContactProvider } from './MockSupplierContactProvider';
import { SupplierContactError } from './SupplierContactProvider';
import {
  NegotiationDispatchRequest,
  NegotiationDispatchResponse,
  RFQDispatchRequest,
  RFQDispatchResponse,
  SupplierContactProvider,
} from './types';

export class SupplierContactService {
  private providers = new Map<string, SupplierContactProvider>();
  private idempotencyStore = new Map<string, RFQDispatchResponse>();
  private inFlightDispatches = new Map<string, Promise<RFQDispatchResponse>>();

  constructor() {
    this.registerProvider(mockSupplierContactProvider);
    this.registerProvider(new EmailSupplierContactProvider());
  }

  public registerProvider(provider: SupplierContactProvider): void {
    this.providers.set(provider.providerName, provider);
  }

  public getProvider(name?: string): SupplierContactProvider {
    const chosen = name || env.SUPPLIER_CONTACT_PROVIDER || 'mock';
    const provider = this.providers.get(chosen);
    if (!provider) {
      throw new SupplierContactError(
        'PROVIDER_ERROR',
        `Supplier contact provider '${chosen}' is not registered`
      );
    }
    return provider;
  }

  public async sendRFQ(
    request: RFQDispatchRequest,
    preferredProvider?: string
  ): Promise<RFQDispatchResponse> {
    const { idempotencyKey } = request;

    // 1. Idempotency Check: Already successfully dispatched
    if (this.idempotencyStore.has(idempotencyKey)) {
      const existing = this.idempotencyStore.get(idempotencyKey)!;
      return {
        ...existing,
        isDuplicate: true,
      };
    }

    // 2. Concurrency Lock: Check if already in-flight
    if (this.inFlightDispatches.has(idempotencyKey)) {
      const result = await this.inFlightDispatches.get(idempotencyKey)!;
      return {
        ...result,
        isDuplicate: true,
      };
    }

    const provider = this.getProvider(preferredProvider);

    // 3. Execute with In-Flight Guard
    const dispatchPromise = (async () => {
      try {
        const response = await provider.sendRFQ(request);
        this.idempotencyStore.set(idempotencyKey, response);
        return response;
      } finally {
        this.inFlightDispatches.delete(idempotencyKey);
      }
    })();

    this.inFlightDispatches.set(idempotencyKey, dispatchPromise);
    return dispatchPromise;
  }

  public async sendNegotiation(
    request: NegotiationDispatchRequest,
    preferredProvider?: string
  ): Promise<NegotiationDispatchResponse> {
    const { idempotencyKey } = request;

    // 1. Idempotency Check: Already successfully dispatched
    if (this.idempotencyStore.has(idempotencyKey)) {
      const existing = this.idempotencyStore.get(idempotencyKey)! as unknown as NegotiationDispatchResponse;
      return {
        ...existing,
        isDuplicate: true,
      };
    }

    // 2. Concurrency Lock: Check if already in-flight
    if (this.inFlightDispatches.has(idempotencyKey)) {
      const result = (await this.inFlightDispatches.get(idempotencyKey)!) as unknown as NegotiationDispatchResponse;
      return {
        ...result,
        isDuplicate: true,
      };
    }

    const provider = this.getProvider(preferredProvider);
    if (!provider.sendNegotiation) {
      throw new SupplierContactError(
        'PROVIDER_ERROR',
        `Provider '${provider.providerName}' does not support negotiation dispatches`
      );
    }

    // 3. Execute with In-Flight Guard
    const dispatchPromise = (async () => {
      try {
        const response = await provider.sendNegotiation!(request);
        this.idempotencyStore.set(idempotencyKey, response as unknown as RFQDispatchResponse);
        return response;
      } finally {
        this.inFlightDispatches.delete(idempotencyKey);
      }
    })();

    this.inFlightDispatches.set(idempotencyKey, dispatchPromise as unknown as Promise<RFQDispatchResponse>);
    return dispatchPromise;
  }

  public reset(): void {
    this.idempotencyStore.clear();
    this.inFlightDispatches.clear();
  }
}

export const supplierContactService = new SupplierContactService();
