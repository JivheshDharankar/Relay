import { SupplierCandidate } from '../types';

/**
 * Deterministic qualification outcome for a discovered supplier candidate.
 * Preserves the critical distinction between clearly eligible, clearly ineligible, and unknown (requires RFQ).
 */
export type QualificationStatus = 'QUALIFIED' | 'REJECTED' | 'REQUIRES_RFQ';

/**
 * Standardized, machine-readable reason codes explaining qualification decisions.
 * Auditable and explainable without probabilistic AI reasoning.
 */
export type QualificationReasonCode =
  // Geographic checks
  | 'DISTANCE_WITHIN_RADIUS'
  | 'OUTSIDE_RADIUS'
  | 'INVALID_COORDINATES'
  | 'INVALID_DISTANCE'

  // Business integrity checks
  | 'VALID_BUSINESS_INFO'
  | 'INVALID_BUSINESS_NAME'
  | 'INVALID_CANDIDATE_ID'

  // Category / Product relevance checks
  | 'CATEGORY_MATCH'
  | 'CATEGORY_MISMATCH'
  | 'CATEGORY_UNKNOWN'

  // Contactability checks
  | 'CONTACT_METHOD_AVAILABLE'
  | 'NO_CONTACT_METHOD'

  // Delivery / SLA feasibility checks
  | 'SLA_FEASIBLE'
  | 'SLA_IMPOSSIBLE'
  | 'DELIVERY_CAPABILITY_UNKNOWN';

/**
 * Runtime criteria used to evaluate a discovered candidate against a procurement request.
 * Completely location-agnostic and product-extensible.
 */
export interface SupplierQualificationCriteria {
  /**
   * Standardized product identifier (e.g. from Relay catalog or request).
   */
  productId?: string;

  /**
   * Product name or search term (e.g. 'Basmati Rice', 'Sunflower Cooking Oil').
   */
  productName?: string;

  /**
   * Procurement product category (e.g. 'Grains & Staples', 'Oils & Ghee', 'Household Cleaning').
   */
  procurementCategory?: string;

  /**
   * Requested procurement quantity.
   */
  quantity?: number;

  /**
   * Standardized unit of measurement (e.g. 'KG', 'LITRE').
   */
  unit?: string;

  /**
   * Maximum acceptable delivery turnaround in hours (defaults to Relay 12h SLA if omitted).
   */
  maxSlaHours?: number;

  /**
   * Explicit delivery deadline requested by resident/society.
   */
  deliveryDeadline?: Date;

  /**
   * Maximum acceptable distance in meters.
   * Defaults to 10,000 meters (10 km) if omitted.
   */
  maxRadiusMeters?: number;

  /**
   * Reference timestamp for deterministic SLA calculations (defaults to runtime now).
   */
  referenceTime?: Date;

  /**
   * Optional pre-verified SLA capability for testing or contracted partners.
   * If undefined, delivery capability is strictly treated as UNKNOWN (requires RFQ).
   */
  verifiedDeliveryHours?: number;
}

/**
 * Structured audit result for a single candidate evaluation.
 */
export interface SupplierQualificationResult {
  /**
   * ID of the candidate evaluated.
   */
  candidateId: string;

  /**
   * Name of the candidate evaluated.
   */
  supplierName: string;

  /**
   * Final deterministic qualification outcome.
   */
  status: QualificationStatus;

  /**
   * All structured reasons explaining why this status was assigned.
   */
  reasons: QualificationReasonCode[];

  /**
   * Sub-list of hard failure reasons if status is REJECTED.
   */
  rejectionReasons: QualificationReasonCode[];

  /**
   * Relevant supplier categories that matched the procurement criteria.
   */
  matchedCategories: string[];

  /**
   * Distance from search origin in kilometers.
   */
  distanceKm: number;

  /**
   * Normalized contactability channels.
   */
  contactChannels: {
    phone?: string;
    email?: string;
    website?: string;
    hasViableContact: boolean;
  };

  /**
   * Discovery provider source ('geoapify', 'mock', etc.).
   */
  source: string;

  /**
   * UTC timestamp when the deterministic qualification occurred.
   */
  qualifiedAt: Date;

  /**
   * Direct composition: original candidate reference.
   */
  candidate: SupplierCandidate;
}

/**
 * Narrowed representation for candidates that are either fully QUALIFIED or eligible for RFQ.
 * Shields downstream procurement from REJECTED candidates.
 */
export interface QualifiedSupplier extends SupplierQualificationResult {
  status: 'QUALIFIED' | 'REQUIRES_RFQ';
}

