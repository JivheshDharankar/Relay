import { randomUUID } from 'crypto';
import { SupplierResponse } from '../types';
import { IngestResponseInput, SupplierResponseProvider } from './types';
import { rfqService as defaultRfqService, RFQService } from '../../rfq/RFQService';
import { SupplierResponseError } from './SupplierResponseProvider';

/**
 * Deterministic supplier response provider for manual entries, testing, and mock submissions.
 */
export class MockSupplierResponseProvider implements SupplierResponseProvider {
  public readonly channel = 'manual';
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
        `Cannot ingest response for RFQ in status '${rfq.status}'`
      );
    }

    const id = `resp_${randomUUID().slice(0, 8)}`;
    const idempotencyKey = input.idempotencyKey || `idemp_resp_${input.rfqId}_${input.candidateId}_${input.providerMessageId || id}`;

    const response: SupplierResponse = {
      id,
      rfqId: input.rfqId,
      candidateId: input.candidateId,
      supplierName: input.supplierName || rfq.supplierName,
      channel: input.channel || this.channel,
      providerMessageId: input.providerMessageId,
      supplierReference: input.supplierReference,
      lineItems: input.lineItems || [],
      deliveryFee: input.deliveryFee,
      tax: input.tax,
      otherCharges: input.otherCharges,
      supplierProvidedTotal: input.supplierProvidedTotal,
      deliveryEtaHours: input.deliveryEtaHours,
      confirmedDeliveryEta: input.confirmedDeliveryEta,
      isSimulated: input.isSimulated,
      validUntil: input.validUntil,
      status: 'RECEIVED',
      idempotencyKey,
      receivedAt: input.receivedAt || new Date(),
      rfq,
    };

    return response;
  }
}

export const mockSupplierResponseProvider = new MockSupplierResponseProvider();
