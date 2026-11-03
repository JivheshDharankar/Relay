/**
 * Status lifecycle of a payment mandate.
 */
export type MandateStatus = 'ACTIVE' | 'PAUSED' | 'REVOKED' | 'EXPIRED';

/**
 * Standard authorized payment purposes in Relay.
 */
export type PaymentPurpose =
  | 'COMMUNITY_PROCUREMENT'
  | 'EMERGENCY_REPAIR'
  | 'MAINTENANCE'
  | 'UTILITY';

/**
 * First-class payment mandate model representing authorized spending capacity
 * granted by the user or community for Relay autonomous procurement execution.
 */
export interface PaymentMandate {
  id: string;
  ownerReference: string; // Resident ID of the mandate owner (the only payer that may be charged)
  purpose: PaymentPurpose;
  currency: string;       // e.g. 'INR'
  spendingLimit: number;
  spentAmount: number;
  reservedAmount: number;
  status: MandateStatus;
  validFrom: Date;
  validUntil?: Date;
  providerReference?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Input for creating a new authorized payment mandate.
 */
export interface CreateMandateInput {
  id?: string;
  ownerReference: string;
  purpose: PaymentPurpose;
  currency?: string;
  spendingLimit: number;
  validFrom?: Date;
  validUntil?: Date;
  providerReference?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Result of deterministic mandate validation.
 */
export interface MandateValidationResult {
  valid: boolean;
  errors: string[];
  remainingCapacity: number;
}

