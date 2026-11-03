import { randomUUID } from 'crypto';
import { DeliveryTrackingProvider } from './tracking/DeliveryTrackingProvider';
import {
  MockDeliveryTrackingProvider,
  mockDeliveryTrackingProvider,
} from './tracking/MockDeliveryTrackingProvider';
import { DeliveryTrackingResult, FulfillmentOrder } from './types';

export class DeliveryTrackingService {
  constructor(
    private readonly provider: DeliveryTrackingProvider = mockDeliveryTrackingProvider
  ) {}

  /**
   * Generates a unique, carrier-compatible tracking waybill code for a fulfillment order.
   */
  public generateTrackingReference(order: FulfillmentOrder): string {
    const prefix = order.fulfillmentType === 'SERVICE' ? 'SRV' : 'TRK';
    const supplierPart = order.supplierId
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 4)
      .toUpperCase();
    const uniquePart = randomUUID().slice(0, 8).toUpperCase();
    return `${prefix}-${supplierPart}-${uniquePart}`;
  }

  /**
   * Queries real-time tracking information from carrier gateway.
   */
  public async getTrackingStatus(
    trackingReference: string
  ): Promise<DeliveryTrackingResult> {
    return this.provider.getTracking(trackingReference);
  }

  public getProvider(): DeliveryTrackingProvider {
    return this.provider;
  }

  public reset(): void {
    if (this.provider instanceof MockDeliveryTrackingProvider) {
      this.provider.reset();
    }
  }
}

export const deliveryTrackingService = new DeliveryTrackingService();

