import { randomUUID } from 'crypto';
import { eventBus } from '../../../events';
import { SupplierQualificationResult } from '../qualification/types';
import { supplierContactService, SupplierContactService } from './contact';
import { assertLegalTransition } from './stateMachine';
import {
  CreateRFQInput,
  RFQ,
  RFQDispatchResult,
  SupplierContactMethod,
} from './types';
import { validateRFQInput } from './validation';

export interface RFQAuditEvent {
  eventType: string;
  rfqId: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export class RFQService {
  private rfqs = new Map<string, RFQ>();
  private auditEvents: RFQAuditEvent[] = [];
  private contactService: SupplierContactService;

  constructor(contactService?: SupplierContactService) {
    this.contactService = contactService ?? supplierContactService;
  }

  /**
   * Generates and validates a new structured RFQ for a qualified or requires-RFQ supplier candidate.
   * Strictly enforces privacy (anonymized demand, no resident PII).
   */
  public async createRFQ(
    input: CreateRFQInput,
    qualification?: SupplierQualificationResult,
    referenceTime = new Date()
  ): Promise<RFQ> {
    // 1. Strict deterministic validation
    validateRFQInput(input, qualification, referenceTime);

    const id = `rfq_${randomUUID().slice(0, 8)}`;
    const idempotencyKey = input.idempotencyKey || `idemp_${id}`;
    const contactMethod: SupplierContactMethod = input.contactMethod || 'email';
    const recipientContact =
      input.recipientContact ||
      (contactMethod === 'email' ? input.candidate.email! : input.candidate.phone!);

    const now = new Date();

    const rfq: RFQ = {
      id,
      candidateId: input.candidate.id,
      supplierName: input.candidate.name,
      candidate: input.candidate,
      contactMethod,
      recipientContact,
      lineItems: input.lineItems,
      deliveryArea: input.deliveryArea,
      deliveryDeadline: input.deliveryDeadline,
      quoteDeadline: input.quoteDeadline,
      status: 'READY',
      idempotencyKey,
      societyId: input.societyId,
      societyName: input.societyName,
      communityOrderId: input.communityOrderId,
      procurementRequestId: input.procurementRequestId,
      createdAt: now,
      updatedAt: now,
      dispatchAttempts: 0,
    };

    this.rfqs.set(id, rfq);

    // 2. Audit Trail & Event Publishing
    this.recordAudit('RFQ_CREATED', id, {
      candidateId: rfq.candidateId,
      supplierName: rfq.supplierName,
      itemCount: rfq.lineItems.length,
    });

    this.recordAudit('RFQ_VALIDATED', id, {
      contactMethod: rfq.contactMethod,
      deliveryArea: rfq.deliveryArea,
    });

    return rfq;
  }

  /**
   * Dispatches an RFQ to the supplier candidate via the configured supplier contact service.
   * Enforces state machine transitions, idempotency, and audit logging.
   */
  public async sendRFQ(
    rfqId: string,
    options?: { preferredProvider?: string; idempotencyKey?: string }
  ): Promise<RFQDispatchResult> {
    const rfq = this.rfqs.get(rfqId);
    if (!rfq) {
      throw new Error(`RFQ '${rfqId}' not found`);
    }

    // 1. Idempotency Check: Already in SENT state with matching idempotency key
    const idempKey = options?.idempotencyKey || rfq.idempotencyKey;
    if (rfq.status === 'SENT' && rfq.idempotencyKey === idempKey) {
      return {
        rfqId,
        status: 'SENT',
        success: true,
        dispatchedAt: rfq.sentAt,
        providerName: rfq.contactMethod,
        recipient: rfq.recipientContact,
        isDuplicate: true,
      };
    }

    // 2. State Machine: Transition to DISPATCHING
    assertLegalTransition(rfq.status, 'DISPATCHING');
    rfq.status = 'DISPATCHING';
    rfq.updatedAt = new Date();

    this.recordAudit('RFQ_DISPATCH_STARTED', rfqId, {
      attempt: rfq.dispatchAttempts + 1,
      idempotencyKey: idempKey,
    });

    // 3. Dispatch via Contact Provider
    try {
      const response = await this.contactService.sendRFQ(
        { rfq, idempotencyKey: idempKey },
        options?.preferredProvider
      );

      // 4. Successful Dispatch: Transition to SENT
      assertLegalTransition(rfq.status, 'SENT');
      rfq.status = 'SENT';
      rfq.sentAt = response.dispatchedAt;
      rfq.updatedAt = new Date();
      rfq.dispatchAttempts += 1;

      this.recordAudit('RFQ_SENT', rfqId, {
        messageId: response.messageId,
        provider: response.providerName,
        recipient: response.recipient,
        isDuplicate: response.isDuplicate,
      });

      return {
        rfqId,
        status: 'SENT',
        success: true,
        messageId: response.messageId,
        dispatchedAt: response.dispatchedAt,
        providerName: response.providerName,
        recipient: response.recipient,
        isDuplicate: response.isDuplicate,
      };
    } catch (err: unknown) {
      // 5. Failed Dispatch: Transition to FAILED
      rfq.status = 'FAILED';
      rfq.failureReason = err instanceof Error ? err.message : String(err);
      rfq.updatedAt = new Date();
      rfq.dispatchAttempts += 1;

      this.recordAudit('RFQ_DISPATCH_FAILED', rfqId, {
        error: rfq.failureReason,
        attempt: rfq.dispatchAttempts,
      });

      throw err;
    }
  }

  public getRFQ(id: string): RFQ | undefined {
    return this.rfqs.get(id);
  }

  public listRFQs(): RFQ[] {
    return Array.from(this.rfqs.values());
  }

  public cancelRFQ(id: string, reason = 'User requested cancellation'): RFQ {
    const rfq = this.rfqs.get(id);
    if (!rfq) {
      throw new Error(`RFQ '${id}' not found`);
    }

    assertLegalTransition(rfq.status, 'CANCELLED');
    rfq.status = 'CANCELLED';
    rfq.failureReason = reason;
    rfq.updatedAt = new Date();

    this.recordAudit('RFQ_CANCELLED', id, { reason });
    return rfq;
  }

  public getRecordedAuditEvents(): RFQAuditEvent[] {
    return [...this.auditEvents];
  }

  public reset(): void {
    this.rfqs.clear();
    this.auditEvents = [];
    this.contactService.reset();
  }

  private recordAudit(
    eventType: string,
    rfqId: string,
    metadata?: Record<string, unknown>
  ): void {
    const event: RFQAuditEvent = {
      eventType,
      rfqId,
      timestamp: new Date().toISOString(),
      metadata,
    };
    this.auditEvents.push(event);

    // Also publish to application-wide domain event bus
    eventBus.publish({
      id: randomUUID(),
      name: eventType,
      aggregateId: rfqId,
      timestamp: event.timestamp,
      payload: event,
    }).catch(() => {});
  }
}

export const rfqService = new RFQService();
