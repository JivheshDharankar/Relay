import { Quote, QuoteStatus } from '../quote/types';

/**
 * Deterministic status lifecycle of a negotiation entity.
 */
export type NegotiationStatus =
  | 'READY'
  | 'PROPOSED'
  | 'SENT'
  | 'WAITING_FOR_RESPONSE'
  | 'COUNTERED'
  | 'REVIEWING'
  | 'ACCEPTABLE'
  | 'ANOTHER_ROUND'
  | 'STOPPED'
  | 'EXPIRED'
  | 'FAILED';

/**
 * High-level negotiation strategic objective chosen by the AI reasoner.
 */
export type NegotiationStrategy =
  | 'LOWER_PRICE'
  | 'REDUCE_DELIVERY_FEE'
  | 'IMPROVE_DELIVERY_TIME'
  | 'INCREASE_AVAILABLE_QUANTITY'
  | 'IMPROVE_TERMS'
  | 'COMBINATION'
  | 'NO_NEGOTIATION';

/**
 * Top-level action decided by the AI agent.
 */
export type NegotiationAction =
  | 'NO_ACTION'
  | 'NEGOTIATE'
  | 'STOP_NEGOTIATION';

/**
 * Structured reason for terminating or completing a negotiation process.
 */
export type NegotiationStopReason =
  | 'ACCEPTABLE_TERMS_ACHIEVED'
  | 'MAX_ROUNDS_REACHED'
  | 'NO_MEANINGFUL_IMPROVEMENT'
  | 'SUPPLIER_REJECTED'
  | 'SUPPLIER_UNRESPONSIVE'
  | 'QUOTE_EXPIRED'
  | 'RFQ_INACTIVE'
  | 'SLA_VIOLATION'
  | 'BUDGET_EXCEEDED'
  | 'MANUAL_STOP';

/**
 * Immutable factual snapshot of verified terms prior to proposal.
 */
export interface NegotiationTermsSnapshot {
  unitPrice: number;
  deliveryFee: number;
  tax: number;
  otherCharges: number;
  total: number;
  deliveryEtaHours?: number;
  confirmedDeliveryEta?: Date;
  availableQuantity: number;
  lineItems: {
    productName: string;
    unitPrice: number;
    quotedQuantity: number;
    requestedQuantity: number;
    isPartial: boolean;
    lineSubtotal: number;
  }[];
}

/**
 * Requested changes proposed by the AI negotiation reasoner.
 */
export interface NegotiationRequestedChanges {
  targetUnitPrice?: number;
  targetDeliveryFee?: number;
  targetDeliveryEtaHours?: number;
  targetQuantity?: number;
  notes?: string;
}

/**
 * Structured commercial negotiation proposal generated for a specific round.
 */
export interface NegotiationProposal {
  id: string;
  negotiationId: string;
  rfqId: string;
  candidateId: string;
  quoteId: string;
  roundNumber: number;
  strategy: NegotiationStrategy;
  currentTerms: NegotiationTermsSnapshot;
  requestedChanges: NegotiationRequestedChanges;
  rationale: string;
  expectedBenefit: string;
  supplierFacingMessage: string;
  status: 'DRAFT' | 'VALIDATED' | 'REJECTED' | 'DISPATCHED';
  validationErrors?: string[];
  createdAt: Date;
  dispatchedAt?: Date;
}

/**
 * Single round within a multi-round negotiation process.
 */
export interface NegotiationRound {
  roundNumber: number;
  proposal: NegotiationProposal;
  dispatchedAt?: Date;
  dispatchMessageId?: string;
  supplierResponseStatus?: 'PENDING' | 'ACCEPTED' | 'COUNTEROFFERED' | 'REJECTED' | 'NO_RESPONSE';
  counterofferResponseId?: string;
  counterofferQuoteId?: string;
  counterofferQuote?: Quote;
  evaluatedAt?: Date;
  evaluationOutcome?: 'ACCEPTABLE' | 'ANOTHER_ROUND' | 'STOPPED';
  evaluationNotes?: string;
}

/**
 * Core Negotiation domain aggregate root.
 */
export interface Negotiation {
  id: string;
  rfqId: string;
  candidateId: string;
  supplierName: string;
  initialQuoteId: string;
  currentQuoteId: string;
  currentBestQuoteId?: string;
  status: NegotiationStatus;
  currentRoundNumber: number;
  maxRounds: number;
  rounds: NegotiationRound[];
  idempotencyKey: string;
  stopReason?: NegotiationStopReason | string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

/**
 * Constrained structured output returned by the AI reasoner.
 */
export interface AINegotiationDecision {
  action: NegotiationAction;
  quoteId: string;
  supplierId: string;
  rfqId: string;
  roundNumber: number;
  strategy: NegotiationStrategy;
  requestedChanges: {
    targetUnitPrice?: string; // Decimal string
    targetDeliveryFee?: string; // Decimal string
    targetDeliveryEtaHours?: number;
    targetQuantity?: string; // Decimal string
    notes?: string;
  };
  rationale: string;
  expectedBenefit: string;
  supplierFacingMessage?: string;
}

/**
 * Factual metrics computed deterministically for each quote.
 */
export interface FactualQuoteMetrics {
  quoteId: string;
  candidateId: string;
  supplierName: string;
  total: number;
  unitPrice: number;
  deliveryFee: number;
  tax: number;
  availableQuantity: number;
  requestedQuantity: number;
  isPartial: boolean;
  deliveryEtaHours?: number;
  isSlaCompliant: boolean;
  slaDeadline: Date;
  validUntil: Date;
  isExpired: boolean;
  isValid: boolean;
  status: QuoteStatus;
  supplierReliabilityScore?: number;
  priceDifferenceFromLowest: number;
  isLowestPrice: boolean;
  /**
   * True when the underlying quote came from Relay's simulated commercial
   * responses rather than a real supplier channel.
   */
  isSimulated?: boolean;
  isFastestDelivery: boolean;
}

/**
 * Normalized factual comparison between multiple quotes.
 */
export interface QuoteFactualComparison {
  rfqId: string;
  quoteCount: number;
  quotes: FactualQuoteMetrics[];
  cheapestQuoteId?: string;
  fastestQuoteId?: string;
  bestFulfillmentQuoteId?: string;
  hardConstraintViolations: {
    quoteId: string;
    reason: string;
  }[];
}

/**
 * Deterministic business policies governing negotiation limits.
 */
export interface NegotiationPolicy {
  maxRounds: number;
  minPriceImprovementPercent: number; // e.g. 1%
  minPriceImprovementAbsolute: number; // e.g. ₹5
  minDeliveryHoursImprovement: number; // e.g. 1 hour
  maxDiscountPercent: number; // e.g. 35%
}

/**
 * Validation result returned by the deterministic validator.
 */
export interface ProposalValidationResult {
  valid: boolean;
  errors: string[];
}
