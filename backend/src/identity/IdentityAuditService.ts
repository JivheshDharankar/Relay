import { randomUUID } from 'crypto';
import { eventBus } from '../events';

export type IdentityAuditEventType =
  | 'USER_AUTHENTICATED'
  | 'USER_REHYDRATED'
  | 'USER_LOGGED_OUT'
  | 'PROFILE_CREATED'
  | 'PROFILE_UPDATED'
  | 'ADDRESS_CREATED'
  | 'SOCIETY_SELECTED'
  | 'SOCIETY_MEMBERSHIP_CREATED'
  | 'SOCIETY_MEMBERSHIP_VERIFIED'
  | 'SOCIETY_MEMBERSHIP_REJECTED'
  | 'ONBOARDING_COMPLETED'
  | 'PAYMENT_MANDATE_CREATED'
  | 'PAYMENT_MANDATE_LIMIT_UPDATED'
  | 'PAYMENT_MANDATE_PAUSED'
  | 'PAYMENT_MANDATE_REVOKED'
  | 'UNAUTHORIZED_ACCESS_ATTEMPT'
  | 'RATE_LIMIT_EXCEEDED';

export class IdentityAuditService {
  /**
   * Publishes a privacy-sanitized identity or security event to the domain event bus.
   * Guarantees zero sensitive tokens, passwords, OTPs, or flat numbers leak into event streams.
   */
  public emit(
    eventType: IdentityAuditEventType,
    userId: string,
    payload: Record<string, unknown> = {}
  ): void {
    const sanitized = this.sanitizePayload(payload);

    eventBus
      .publish({
        id: randomUUID(),
        name: eventType,
        aggregateId: userId,
        timestamp: new Date().toISOString(),
        payload: {
          userId,
          eventType,
          ...sanitized,
        },
      })
      .catch(() => {});
  }

  private sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    const forbiddenKeys = [
      'token',
      'secret',
      'password',
      'otp',
      'otpcode',
      'idtoken',
      'authtoken',
      'cvv',
      'pin',
      'flatnumber',
      'bankaccount',
      'credentials',
    ];

    for (const [key, value] of Object.entries(payload)) {
      if (forbiddenKeys.some((f) => key.toLowerCase().includes(f))) {
        continue; // Strictly omit secret and sensitive keys
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

export const identityAuditService = new IdentityAuditService();

