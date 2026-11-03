import { randomUUID } from 'crypto';
import {
  ProcurementCommitment,
  PurchaseOrder,
} from '../../discovery/supplier/selection/types';
import { MandateService, mandateService } from '../mandate/MandateService';
import { PaymentMandate, PaymentPurpose } from '../mandate/types';
import { PaymentAuthorization } from '../types';
import {
  PaymentAuthorizationValidator,
  paymentAuthorizationValidator,
} from './PaymentAuthorizationValidator';

export interface AuthorizePaymentInput {
  commitment: ProcurementCommitment;
  purchaseOrder: PurchaseOrder;
  mandate: PaymentMandate;
  amount: number;
  currency?: string;
  purpose?: PaymentPurpose;
  alreadyPaid?: boolean;
}

export class PaymentAuthorizationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Payment authorization failed: ${errors.join('; ')}`);
    this.name = 'PaymentAuthorizationError';
  }
}

export class PaymentAuthorizationService {
  private authorizations = new Map<string, PaymentAuthorization>();

  constructor(
    private readonly validator: PaymentAuthorizationValidator = paymentAuthorizationValidator,
    private readonly mandateSvc: MandateService = mandateService
  ) {}

  /**
   * Deterministically authorizes a payment request against commitment, PO, mandate, and limits,
   * atomically reserving mandate capacity to prevent race conditions.
   */
  public async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<PaymentAuthorization> {
    const authId = `auth_${randomUUID().slice(0, 8)}`;
    const currency = input.currency || input.commitment.financials.currency || 'INR';
    const purpose = input.purpose || 'COMMUNITY_PROCUREMENT';
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15-minute authorization window

    // 1. Run deterministic authorization validation rules
    const validation = this.validator.validate({
      commitment: input.commitment,
      purchaseOrder: input.purchaseOrder,
      mandate: input.mandate,
      amount: input.amount,
      currency,
      purpose,
      supplierId: input.purchaseOrder.supplierId,
      alreadyPaid: input.alreadyPaid,
    });

    if (!validation.valid) {
      const rejectedAuth: PaymentAuthorization = {
        id: authId,
        commitmentId: input.commitment.id,
        purchaseOrderId: input.purchaseOrder.id,
        supplierId: input.purchaseOrder.supplierId,
        supplierName: input.purchaseOrder.supplierName,
        mandateId: input.mandate.id,
        amount: input.amount,
        currency,
        purpose,
        status: 'REJECTED',
        authorizedAt: now,
        expiresAt,
        rejectionReasons: validation.errors,
      };

      this.authorizations.set(authId, rejectedAuth);
      throw new PaymentAuthorizationError(validation.errors);
    }

    // 2. Atomically reserve spending capacity on the mandate
    const reservation = await this.mandateSvc.reserveCapacity(
      input.mandate.id,
      input.amount,
      { currency, purpose, referenceTime: now }
    );

    if (!reservation.success) {
      const errorMsg = reservation.error || 'SPENDING_LIMIT_EXCEEDED';
      const rejectedAuth: PaymentAuthorization = {
        id: authId,
        commitmentId: input.commitment.id,
        purchaseOrderId: input.purchaseOrder.id,
        supplierId: input.purchaseOrder.supplierId,
        supplierName: input.purchaseOrder.supplierName,
        mandateId: input.mandate.id,
        amount: input.amount,
        currency,
        purpose,
        status: 'REJECTED',
        authorizedAt: now,
        expiresAt,
        rejectionReasons: [errorMsg],
      };

      this.authorizations.set(authId, rejectedAuth);
      throw new PaymentAuthorizationError([errorMsg]);
    }

    // 3. Create approved PaymentAuthorization record
    const authorizedRecord: PaymentAuthorization = {
      id: authId,
      commitmentId: input.commitment.id,
      purchaseOrderId: input.purchaseOrder.id,
      supplierId: input.purchaseOrder.supplierId,
      supplierName: input.purchaseOrder.supplierName,
      mandateId: input.mandate.id,
      amount: input.amount,
      currency,
      purpose,
      status: 'AUTHORIZED',
      authorizedAt: now,
      expiresAt,
      commercialBasisSimulated: input.commitment.commercialBasisSimulated,
    };

    this.authorizations.set(authId, authorizedRecord);
    return authorizedRecord;
  }

  public getAuthorization(id: string): PaymentAuthorization | undefined {
    return this.authorizations.get(id);
  }

  public listAuthorizations(): PaymentAuthorization[] {
    return Array.from(this.authorizations.values());
  }

  public reset(): void {
    this.authorizations.clear();
  }
}

export const paymentAuthorizationService = new PaymentAuthorizationService();

