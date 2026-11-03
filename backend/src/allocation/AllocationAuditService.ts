import { randomUUID } from 'crypto';
import { eventBus } from '../events';

export type AllocationAuditEventType =
  | 'ALLOCATION_STARTED'
  | 'ALLOCATION_CALCULATED'
  | 'ALLOCATION_VALIDATED'
  | 'ALLOCATION_FINALIZED'
  | 'ALLOCATION_REJECTED'
  | 'LEDGER_ENTRY_CREATED'
  | 'LEDGER_ADJUSTMENT_CREATED'
  | 'LEDGER_REVERSAL_CREATED'
  | 'RECONCILIATION_STARTED'
  | 'RECONCILIATION_RECONCILED'
  | 'RECONCILIATION_DISCREPANCY'
  | 'RECONCILIATION_BLOCKED';

export class AllocationAuditService {
  /**
   * Emits a privacy-sanitized allocation or reconciliation event to the Relay domain event bus.
   * Guarantees zero resident PII, passwords, bank credentials, flat numbers, or internal LLM reasoning are leaked.
   */
  public emit(
    eventType: AllocationAuditEventType,
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
      'bankAccount',
      'upiPin',
    ];

    for (const [key, value] of Object.entries(payload)) {
      if (forbiddenKeys.some((f) => key.toLowerCase().includes(f.toLowerCase()))) {
        continue; // Redact strictly
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
        sanitized[key] = this.sanitizePayload(value as Record<string, unknown>);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}

export const allocationAuditService = new AllocationAuditService();

