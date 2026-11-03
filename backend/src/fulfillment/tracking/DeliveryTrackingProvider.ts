import { DeliveryTrackingResult } from '../types';

/**
 * Provider-agnostic carrier and logistics tracking interface.
 */
export interface DeliveryTrackingProvider {
  readonly providerName: string;
  readonly isSimulated: boolean;

  /**
   * Retrieves tracking details from logistics provider for a given tracking code.
   */
  getTracking(trackingReference: string): Promise<DeliveryTrackingResult>;
}

