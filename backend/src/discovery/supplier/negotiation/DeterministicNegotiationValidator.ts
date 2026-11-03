import {
  isGreaterThan,
  isGreaterThanOrEqual,
  isLessThan,
  isPositive,
  subtractDecimals,
  toDecimal,
} from '../../../domain/procurement/decimal';
import { Quote } from '../quote/types';
import { RFQ } from '../rfq/types';
import {
  NegotiationPolicy,
  NegotiationProposal,
  NegotiationStrategy,
  ProposalValidationResult,
} from './types';

const ALLOWED_STRATEGIES: NegotiationStrategy[] = [
  'LOWER_PRICE',
  'REDUCE_DELIVERY_FEE',
  'IMPROVE_DELIVERY_TIME',
  'INCREASE_AVAILABLE_QUANTITY',
  'IMPROVE_TERMS',
  'COMBINATION',
  'NO_NEGOTIATION',
];

const FORBIDDEN_PATTERN_PII = /\b(flat\s*\d+|tower\s*[a-z0-9]|res_[a-z0-9_]+|resident|apartment\s*\d+|mandate|budget\s*limit|spending\s*limit)\b/i;
const FORBIDDEN_PATTERN_AI = /\b(system\s*prompt|as\s*an?\s*ai|language\s*model|instructions\s*given)\b/i;

export class DeterministicNegotiationValidator {
  /**
   * Strictly validates a negotiation proposal against deterministic domain, business, and privacy invariants.
   */
  public validateProposal(
    proposal: NegotiationProposal,
    rfq: RFQ,
    quote: Quote,
    policy: NegotiationPolicy,
    competitorNames: string[] = [],
    referenceTime: Date = new Date()
  ): ProposalValidationResult {
    const errors: string[] = [];

    // 1. Validate Strategy
    if (!ALLOWED_STRATEGIES.includes(proposal.strategy)) {
      errors.push(`INVALID_STRATEGY: Strategy '${proposal.strategy}' is not recognized`);
    }

    // 2. Validate RFQ State
    if (rfq.status === 'CANCELLED' || rfq.status === 'EXPIRED' || rfq.status === 'FAILED') {
      errors.push(`RFQ_INACTIVE: Originating RFQ is in '${rfq.status}' state`);
    }

    // 3. Validate Supplier Consistency
    if (proposal.candidateId !== rfq.candidateId || proposal.candidateId !== quote.candidateId) {
      errors.push('SUPPLIER_MISMATCH: Proposal candidate does not match RFQ and Quote supplier');
    }

    // 4. Validate Quote State & Expiry
    if (quote.status === 'INVALID') {
      errors.push('QUOTE_INVALID: Cannot negotiate against an invalid quote');
    }
    if (quote.validUntil.getTime() <= referenceTime.getTime()) {
      errors.push('QUOTE_EXPIRED: Originating quote has expired');
    }

    // 5. Validate Round Number against Configured Maximum
    if (proposal.roundNumber <= 0) {
      errors.push('INVALID_ROUND: Round number must be greater than zero');
    }
    if (proposal.roundNumber > policy.maxRounds) {
      errors.push(
        `MAX_ROUNDS_EXCEEDED: Round ${proposal.roundNumber} exceeds maximum configured rounds (${policy.maxRounds})`
      );
    }

    // 6. Validate Requested Changes
    const changes = proposal.requestedChanges;
    let hasAtLeastOneRequestedChange = false;
    let hasMeaningfulImprovement = false;

    // A. Target Unit Price Validation
    if (changes.targetUnitPrice !== undefined) {
      hasAtLeastOneRequestedChange = true;
      if (isLessThan(changes.targetUnitPrice, 0)) {
        errors.push('NEGATIVE_TARGET_PRICE: Target unit price cannot be negative');
      } else {
        const currentUnitPrice = quote.lineItems[0]?.unitPrice ?? toDecimal(0);
        if (isGreaterThan(changes.targetUnitPrice, currentUnitPrice)) {
          errors.push('TARGET_PRICE_EXCEEDS_CURRENT: Target unit price cannot be higher than quoted price');
        } else {
          const priceDiff = subtractDecimals(currentUnitPrice, changes.targetUnitPrice);
          const minAbsolute = toDecimal(policy.minPriceImprovementAbsolute);
          const percentReduction = isPositive(currentUnitPrice)
            ? priceDiff.dividedBy(currentUnitPrice).times(100).toNumber()
            : 0;

          if (
            isGreaterThanOrEqual(priceDiff, minAbsolute) ||
            percentReduction >= policy.minPriceImprovementPercent
          ) {
            hasMeaningfulImprovement = true;
          }

          // Sanity check: prevent unrealistic discounts (e.g. > 50% discount)
          if (percentReduction > policy.maxDiscountPercent) {
            errors.push(
              `UNREALISTIC_DISCOUNT: Requested discount (${percentReduction.toFixed(1)}%) exceeds maximum allowed discount (${policy.maxDiscountPercent}%)`
            );
          }
        }
      }
    }

    // B. Target Delivery Fee Validation
    if (changes.targetDeliveryFee !== undefined) {
      hasAtLeastOneRequestedChange = true;
      if (isLessThan(changes.targetDeliveryFee, 0)) {
        errors.push('NEGATIVE_DELIVERY_FEE: Target delivery fee cannot be negative');
      } else {
        const currentFee = quote.deliveryFee;
        if (isGreaterThan(changes.targetDeliveryFee, currentFee)) {
          errors.push('TARGET_DELIVERY_FEE_EXCEEDS_CURRENT: Target delivery fee cannot exceed quoted fee');
        } else {
          const feeDiff = subtractDecimals(currentFee, changes.targetDeliveryFee);
          if (isGreaterThanOrEqual(feeDiff, policy.minPriceImprovementAbsolute)) {
            hasMeaningfulImprovement = true;
          }
        }
      }
    }

    // C. Target Delivery ETA Validation & SLA Compatibility
    if (changes.targetDeliveryEtaHours !== undefined) {
      hasAtLeastOneRequestedChange = true;
      if (changes.targetDeliveryEtaHours <= 0) {
        errors.push('INVALID_DELIVERY_HOURS: Target delivery hours must be positive');
      } else {
        const currentEta = quote.deliveryEtaHours ?? 999;
        if (changes.targetDeliveryEtaHours > currentEta) {
          errors.push('TARGET_DELIVERY_EXCEEDS_CURRENT: Target delivery hours cannot be slower than current quote');
        } else if (currentEta - changes.targetDeliveryEtaHours >= policy.minDeliveryHoursImprovement) {
          hasMeaningfulImprovement = true;
        }

        // SLA Check: Promised target delivery must not exceed RFQ deadline
        const slaDeadline = rfq.deliveryDeadline ?? new Date(Date.now() + 86400000);
        const requestedDeliveryDate = new Date(
          referenceTime.getTime() + changes.targetDeliveryEtaHours * 3600 * 1000
        );
        if (requestedDeliveryDate.getTime() > slaDeadline.getTime()) {
          errors.push('SLA_VIOLATION: Requested delivery ETA violates RFQ delivery deadline');
        }
      }
    }

    // D. Target Quantity Validation
    if (changes.targetQuantity !== undefined) {
      hasAtLeastOneRequestedChange = true;
      if (!isPositive(changes.targetQuantity)) {
        errors.push('INVALID_QUANTITY: Target quantity must be greater than zero');
      } else {
        const currentAvailable = quote.lineItems.reduce(
          (acc, li) => acc + li.quotedQuantity,
          0
        );
        if (isGreaterThan(changes.targetQuantity, currentAvailable)) {
          hasMeaningfulImprovement = true;
        }
      }
    }

    // Meaningful improvement requirement
    if (proposal.strategy !== 'NO_NEGOTIATION') {
      if (!hasAtLeastOneRequestedChange) {
        errors.push('NO_REQUESTED_CHANGES: Negotiation proposal must specify at least one target change');
      } else if (!hasMeaningfulImprovement) {
        errors.push(
          'NO_MEANINGFUL_IMPROVEMENT: Requested changes do not meet minimum improvement thresholds'
        );
      }
    }

    // 7. Rationale Validation
    if (!proposal.rationale || proposal.rationale.trim().length === 0) {
      errors.push('MISSING_RATIONALE: Negotiation proposal must provide a rationale');
    }

    // 8. Privacy, Confidentiality & Anti-Hallucination Guardrails
    const messageToCheck = `${proposal.supplierFacingMessage} ${proposal.rationale} ${changes.notes || ''}`;

    if (FORBIDDEN_PATTERN_PII.test(messageToCheck)) {
      errors.push('PRIVACY_VIOLATION: Negotiation message contains prohibited resident PII or internal budget data');
    }

    if (FORBIDDEN_PATTERN_AI.test(messageToCheck)) {
      errors.push('PROMPT_LEAKAGE: Negotiation message contains internal AI prompt markers');
    }

    // Competitor confidentiality: Supplier A must not be informed of Supplier B's identity
    for (const competitor of competitorNames) {
      if (competitor && competitor.toLowerCase() !== proposal.candidateId.toLowerCase()) {
        const competitorRegex = new RegExp(`\\b${escapeRegExp(competitor)}\\b`, 'i');
        if (competitorRegex.test(messageToCheck)) {
          errors.push(
            `CONFIDENTIALITY_VIOLATION: Message reveals competitor supplier identity '${competitor}'`
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const deterministicNegotiationValidator = new DeterministicNegotiationValidator();
