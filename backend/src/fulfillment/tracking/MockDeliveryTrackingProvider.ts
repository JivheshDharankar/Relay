import { DeliveryTrackingResult } from '../types';
import { DeliveryTrackingProvider } from './DeliveryTrackingProvider';

export class MockDeliveryTrackingProvider implements DeliveryTrackingProvider {
  public readonly providerName = 'MockDeliveryTrackingProvider';
  public readonly isSimulated = true;

  private statusOverrides = new Map<
    string,
    { status: DeliveryTrackingResult['status']; location?: string }
  >();
  private failureOverrides = new Map<
    string,
    { code: string; reason: string }
  >();
  private timeoutOverrides = new Set<string>();

  public async getTracking(trackingReference: string): Promise<DeliveryTrackingResult> {
    if (this.timeoutOverrides.has(trackingReference)) {
      throw new Error(`Carrier tracking gateway timeout for '${trackingReference}'`);
    }

    if (this.failureOverrides.has(trackingReference)) {
      const err = this.failureOverrides.get(trackingReference)!;
      throw new Error(`Tracking query failed (${err.code}): ${err.reason}`);
    }

    const override = this.statusOverrides.get(trackingReference);
    const now = new Date();

    const status: DeliveryTrackingResult['status'] =
      override?.status || 'IN_TRANSIT';
    const location: string =
      override?.location || 'Regional Fulfillment Hub';

    return {
      trackingReference,
      carrier: 'Relay Logistics Network (Simulated)',
      status,
      location,
      estimatedDeliveryAt: new Date(now.getTime() + 4 * 3600 * 1000),
      deliveredAt: status === 'DELIVERED' ? now : undefined,
      lastUpdated: now,
      isSimulated: true,
    };
  }

  public simulateStatus(
    trackingReference: string,
    status: DeliveryTrackingResult['status'],
    location?: string
  ): void {
    this.statusOverrides.set(trackingReference, { status, location });
  }

  public simulateFailure(
    trackingReference: string,
    code = 'TRACKING_NOT_FOUND',
    reason = 'Waybill not recognized by carrier network'
  ): void {
    this.failureOverrides.set(trackingReference, { code, reason });
  }

  public simulateTimeout(trackingReference: string): void {
    this.timeoutOverrides.add(trackingReference);
  }

  public clearOverrides(): void {
    this.statusOverrides.clear();
    this.failureOverrides.clear();
    this.timeoutOverrides.clear();
  }

  public reset(): void {
    this.clearOverrides();
  }
}

export const mockDeliveryTrackingProvider = new MockDeliveryTrackingProvider();

