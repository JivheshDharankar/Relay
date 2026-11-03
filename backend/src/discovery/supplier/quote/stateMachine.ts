import { QuoteStatus, SupplierResponseStatus } from './types';

export class QuoteStateMachineError extends Error {
  public readonly fromStatus: string;
  public readonly toStatus: string;

  constructor(fromStatus: string, toStatus: string, message?: string) {
    super(
      message || `Illegal quote status transition: cannot transition from '${fromStatus}' to '${toStatus}'`
    );
    this.name = 'QuoteStateMachineError';
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

/**
 * Deterministic transition rules for Quote lifecycle.
 */
const LEGAL_QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  RECEIVED: ['VALIDATING', 'INVALID'],
  VALIDATING: ['VALID', 'PARTIAL', 'INVALID'],
  VALID: ['EXPIRED', 'SUPERSEDED'],
  PARTIAL: ['EXPIRED', 'SUPERSEDED'],
  INVALID: [],
  EXPIRED: [],
  SUPERSEDED: [],
};

/**
 * Validates whether a Quote state transition is legal.
 */
export function canTransitionQuote(from: QuoteStatus, to: QuoteStatus): boolean {
  if (from === to) return true;
  return LEGAL_QUOTE_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Asserts that a Quote transition is legal, throwing QuoteStateMachineError if not.
 */
export function assertLegalQuoteTransition(from: QuoteStatus, to: QuoteStatus): void {
  if (!canTransitionQuote(from, to)) {
    throw new QuoteStateMachineError(from, to);
  }
}

/**
 * Deterministic transition rules for SupplierResponse ingestion lifecycle.
 */
const LEGAL_RESPONSE_TRANSITIONS: Record<SupplierResponseStatus, SupplierResponseStatus[]> = {
  RECEIVED: ['PROCESSING', 'REJECTED'],
  PROCESSING: ['NORMALIZED', 'FAILED', 'REJECTED'],
  NORMALIZED: [],
  REJECTED: [],
  FAILED: ['PROCESSING'],
};

/**
 * Validates whether a SupplierResponse state transition is legal.
 */
export function canTransitionResponse(
  from: SupplierResponseStatus,
  to: SupplierResponseStatus
): boolean {
  if (from === to) return true;
  return LEGAL_RESPONSE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertLegalResponseTransition(
  from: SupplierResponseStatus,
  to: SupplierResponseStatus
): void {
  if (!canTransitionResponse(from, to)) {
    throw new QuoteStateMachineError(from, to, `Illegal response transition: '${from}' -> '${to}'`);
  }
}

