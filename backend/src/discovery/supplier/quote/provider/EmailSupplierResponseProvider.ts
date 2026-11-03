import { randomUUID } from 'crypto';
import { rfqService as defaultRfqService, RFQService } from '../../rfq/RFQService';
import { SupplierResponse } from '../types';
import { SupplierResponseError } from './SupplierResponseProvider';
import { IngestResponseInput, SupplierResponseProvider } from './types';

/**
 * Provider handling supplier responses transmitted via inbound email or email webhook events.
 */
export class EmailSupplierResponseProvider implements SupplierResponseProvider {
  public readonly channel = 'email';
  private rfqService: RFQService;

  constructor(rfqServiceInstance?: RFQService) {
    this.rfqService = rfqServiceInstance ?? defaultRfqService;
  }

  public async ingest(input: IngestResponseInput): Promise<SupplierResponse> {
    const rfq = this.rfqService.getRFQ(input.rfqId);
    if (!rfq) {
      throw new SupplierResponseError(
        'RFQ_NOT_FOUND',
        `No RFQ found for reference '${input.rfqId}'`
      );
    }

    if (rfq.candidateId !== input.candidateId) {
      throw new SupplierResponseError(
        'SUPPLIER_MISMATCH',
        `Response candidate ID '${input.candidateId}' does not match RFQ candidate ID '${rfq.candidateId}'`
      );
    }

    if (rfq.status === 'CANCELLED' || rfq.status === 'EXPIRED') {
      throw new SupplierResponseError(
        'RFQ_INACTIVE',
        `Cannot ingest email response for RFQ in status '${rfq.status}'`
      );
    }

    const id = `resp_${randomUUID().slice(0, 8)}`;
    const idempotencyKey =
      input.idempotencyKey ||
      `idemp_email_${input.rfqId}_${input.providerMessageId || id}`;

    const response: SupplierResponse = {
      id,
      rfqId: input.rfqId,
      candidateId: input.candidateId,
      supplierName: input.supplierName || rfq.supplierName,
      channel: 'email',
      providerMessageId: input.providerMessageId,
      supplierReference: input.supplierReference,
      lineItems: input.lineItems || [],
      deliveryFee: input.deliveryFee,
      tax: input.tax,
      otherCharges: input.otherCharges,
      supplierProvidedTotal: input.supplierProvidedTotal,
      deliveryEtaHours: input.deliveryEtaHours,
      confirmedDeliveryEta: input.confirmedDeliveryEta,
      validUntil: input.validUntil,
      status: 'RECEIVED',
      idempotencyKey,
      receivedAt: input.receivedAt || new Date(),
      rfq,
    };

    return response;
  }
}

export const emailSupplierResponseProvider = new EmailSupplierResponseProvider();
