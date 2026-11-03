import { SupplierQualificationResult } from '../qualification/types';
import { CreateRFQInput, RFQLineItem } from './types';

export type RFQValidationErrorCode =
  | 'MISSING_CANDIDATE'
  | 'CANDIDATE_REJECTED'
  | 'MISSING_CONTACT_CHANNEL'
  | 'EMPTY_LINE_ITEMS'
  | 'INVALID_QUANTITY'
  | 'INVALID_UNIT'
  | 'MISSING_PRODUCT_INFO'
  | 'INVALID_QUOTE_DEADLINE'
  | 'INVALID_DELIVERY_DEADLINE'
  | 'DEADLINE_INCOMPATIBLE'
  | 'PRIVACY_VIOLATION';

export class RFQValidationError extends Error {
  public readonly code: RFQValidationErrorCode;
  public readonly details?: unknown;

  constructor(code: RFQValidationErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'RFQValidationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Basic email format verification regex.
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Keywords indicating private resident housing details that must NOT appear in external supplier RFQs.
 */
const PRIVATE_RESIDENT_PATTERNS = [
  /\bflat\b/i,
  /\bapt\b/i,
  /\bapartment\b/i,
  /\bunit\b/i,
  /\btower\s+[a-z0-9]+/i,
  /\bblock\s+[a-z0-9]+/i,
  /\bdoor\b/i,
  /\broom\b/i,
];

/**
 * Validates RFQ input against all deterministic requirements before creating or dispatching.
 */
export function validateRFQInput(
  input: CreateRFQInput,
  qualification?: SupplierQualificationResult,
  referenceTime = new Date()
): void {
  // 1. Candidate Presence
  const { candidate } = input;
  if (!candidate || !candidate.id) {
    throw new RFQValidationError(
      'MISSING_CANDIDATE',
      'Supplier candidate is required to generate an RFQ'
    );
  }

  // 2. Candidate Status Check: REJECTED candidates can NEVER receive RFQs
  if (qualification && qualification.status === 'REJECTED') {
    throw new RFQValidationError(
      'CANDIDATE_REJECTED',
      `Cannot issue RFQ: Candidate '${candidate.name}' (${candidate.id}) failed qualification checks. Reasons: ${qualification.rejectionReasons.join(', ')}`
    );
  }

  // 3. Contact Method & Destination Verification
  const contactMethod = input.contactMethod || 'email';
  const recipientContact =
    input.recipientContact ||
    (contactMethod === 'email' ? candidate.email : candidate.phone);

  if (!recipientContact || recipientContact.trim().length === 0) {
    throw new RFQValidationError(
      'MISSING_CONTACT_CHANNEL',
      `Candidate '${candidate.name}' does not have a destination contact for method '${contactMethod}'`
    );
  }

  if (contactMethod === 'email' && !EMAIL_REGEX.test(recipientContact.trim())) {
    throw new RFQValidationError(
      'MISSING_CONTACT_CHANNEL',
      `Invalid email address for supplier candidate: '${recipientContact}'`
    );
  }

  // 4. Line Items Verification
  if (!input.lineItems || input.lineItems.length === 0) {
    throw new RFQValidationError(
      'EMPTY_LINE_ITEMS',
      'RFQ must contain at least one line item'
    );
  }

  for (let i = 0; i < input.lineItems.length; i++) {
    const item = input.lineItems[i];
    validateLineItem(item, i);
  }

  // 5. Deadlines Verification
  if (!input.quoteDeadline || Number.isNaN(input.quoteDeadline.getTime())) {
    throw new RFQValidationError(
      'INVALID_QUOTE_DEADLINE',
      'Quote response deadline must be a valid date'
    );
  }

  if (!input.deliveryDeadline || Number.isNaN(input.deliveryDeadline.getTime())) {
    throw new RFQValidationError(
      'INVALID_DELIVERY_DEADLINE',
      'Delivery deadline must be a valid date'
    );
  }

  if (input.quoteDeadline.getTime() <= referenceTime.getTime()) {
    throw new RFQValidationError(
      'INVALID_QUOTE_DEADLINE',
      'Quote response deadline must be in the future'
    );
  }

  if (input.deliveryDeadline.getTime() <= referenceTime.getTime()) {
    throw new RFQValidationError(
      'INVALID_DELIVERY_DEADLINE',
      'Delivery deadline must be in the future'
    );
  }

  if (input.quoteDeadline.getTime() >= input.deliveryDeadline.getTime()) {
    throw new RFQValidationError(
      'DEADLINE_INCOMPATIBLE',
      'Quote response deadline must precede the delivery deadline'
    );
  }

  // 6. Privacy & Resident Anonymization Safeguards
  if (input.deliveryArea) {
    for (const pattern of PRIVATE_RESIDENT_PATTERNS) {
      if (pattern.test(input.deliveryArea)) {
        throw new RFQValidationError(
          'PRIVACY_VIOLATION',
          `Delivery area contains resident-specific PII/flat details ('${input.deliveryArea}'). Must specify only community/neighborhood level location.`
        );
      }
    }
  }
}

function validateLineItem(item: RFQLineItem, index: number): void {
  if (!item.productName || item.productName.trim().length === 0) {
    throw new RFQValidationError(
      'MISSING_PRODUCT_INFO',
      `Line item at index ${index} is missing productName`
    );
  }

  if (
    typeof item.quantity !== 'number' ||
    Number.isNaN(item.quantity) ||
    item.quantity <= 0
  ) {
    throw new RFQValidationError(
      'INVALID_QUANTITY',
      `Line item '${item.productName}' must have a positive quantity. Received ${item.quantity}`
    );
  }

  if (!item.unit || item.unit.trim().length === 0) {
    throw new RFQValidationError(
      'INVALID_UNIT',
      `Line item '${item.productName}' is missing measurement unit`
    );
  }
}
