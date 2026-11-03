import {
  SupplierResponse,
  SupplierResponseChannel,
  SupplierResponseLineItem,
} from '../types';

export interface IngestResponseInput {
  rfqId: string;
  candidateId: string;
  supplierName: string;
  channel: SupplierResponseChannel;
  providerMessageId?: string;
  supplierReference?: string;
  lineItems: SupplierResponseLineItem[];
  deliveryFee?: number;
  tax?: number;
  otherCharges?: number;
  supplierProvidedTotal?: number;
  deliveryEtaHours?: number;
  confirmedDeliveryEta?: Date;
  validUntil?: Date;
  idempotencyKey?: string;
  receivedAt?: Date;
  isSimulated?: boolean;
}

export interface SupplierResponseProvider {
  readonly channel: SupplierResponseChannel;

  /**
   * Translates incoming channel payload into a normalized SupplierResponse entity.
   */
  ingest(input: IngestResponseInput): Promise<SupplierResponse>;
}

