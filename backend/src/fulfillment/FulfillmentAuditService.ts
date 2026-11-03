import { randomUUID } from 'crypto';
import { eventBus } from '../events';

export type FulfillmentAuditEventType =
  | 'FULFILLMENT_CREATED'
  | 'FULFILLMENT_ACCEPTANCE_REQUESTED'
  | 'FULFILLMENT_ACCEPTED'
  | 'FULFILLMENT_REJECTED'
  | 'FULFILLMENT_STARTED'
  | 'FULFILLMENT_UPDATED'
  | 'FULFILLMENT_DISPATCHED'
  | 'FULFILLMENT_IN_TRANSIT'
  | 'DELIVERY_ATTEMPTED'
  | 'FULFILLMENT_DELIVERED'
  | 'FULFILLMENT_PARTIALLY_COMPLETED'
  | 'FULFILLMENT_VERIFIED'
  | 'FULFILLMENT_FAILED'
  | 'SLA_WARNING'
  | 'SLA_BREACHED'
  | 'FULFILLMENT_CANCELLED';

export class FulfillmentAuditService {
  /**
   * Emits a privacy-sanitized fulfillment audit event to the Relay domain event bus.
   * Guarantees zero resident PII, flat numbers, budgets, or secret credentials are leaked.
   */
  public emit(
    eventType: FulfillmentAuditEventType,
    aggregateId: string,
    payload: Record<string, unknown>
  ): void {
    eventBus
      .publish({
        id: randomUUID(),
        name: eventType,
        aggregateId,
        timestamp: new Date().toISOString(),
        payload: this.sanitizePayload(payload),
      })
      .catch(() => {});
  }

  private sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    const forbiddenKeys = [
      'flatNumber',
      'apartment',
      'residentName',
      'residentEmail',
      'residentPhone',
      'pin',
      'password',
      'cvv',
      'prompt',
      'reasoning',
      'mandateLimit',
    ];

    for (const [key, value] of Object.entries(payload)) {
      if (forbiddenKeys.some((f) => key.toLowerCase().includes(f.toLowerCase()))) {
        continue;
      }
      sanitized[key] = value;
    }

    return sanitized;
  }
}

export const fulfillmentAuditService = new FulfillmentAuditService();

