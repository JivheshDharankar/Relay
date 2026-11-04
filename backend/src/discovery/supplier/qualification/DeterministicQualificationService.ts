import { SupplierCandidate } from '../types';
import {
  CategoryMappingRegistry,
  matchSupplierCategories,
} from './categoryMapping';
import {
  QualificationReasonCode,
  QualificationStatus,
  QualifiedSupplier,
  SupplierQualificationCriteria,
  SupplierQualificationResult,
} from './types';

/**
 * Keywords in supplier business names that clearly indicate non-grocery / ineligible establishments.
 */
const NON_GROCERY_NAME_KEYWORDS = [
  'department of',
  'university',
  'college',
  'school',
  'institute',
  'coep',
  'hostel',
  'kpop',
  'fan store',
  'cafe',
  'café',
  'restaurant',
  'bar',
  'hotel',
  'hospital',
  'pharmacy',
  'bank',
  'atm',
  'gym',
  'cinema',
  'theatre',
];

/**
 * Deterministic qualification service for local supplier candidates.
 * Acts as an immutable safety and eligibility boundary before any AI evaluation or RFQ dispatch.
 */
export class DeterministicQualificationService {
  /**
   * Evaluates a single discovered supplier candidate against explicit procurement criteria.
   */
  public qualifyCandidate(
    candidate: SupplierCandidate,
    criteria: SupplierQualificationCriteria
  ): SupplierQualificationResult {
    const reasons: QualificationReasonCode[] = [];
    const rejectionReasons: QualificationReasonCode[] = [];
    const matchedCategories: string[] = [];

    // =========================================================================
    // 0. NON-GROCERY ESTABLISHMENT FILTER
    // =========================================================================
    const lowerName = (candidate.name || '').toLowerCase();
    for (const kw of NON_GROCERY_NAME_KEYWORDS) {
      if (lowerName.includes(kw)) {
        rejectionReasons.push('CATEGORY_MISMATCH');
        break;
      }
    }

    // =========================================================================
    // 1. BUSINESS INFORMATION QUALITY CHECK
    // =========================================================================
    let hasValidBusinessInfo = true;

    if (!candidate.id || candidate.id.trim().length === 0) {
      rejectionReasons.push('INVALID_CANDIDATE_ID');
      hasValidBusinessInfo = false;
    }

    if (!candidate.name || candidate.name.trim().length === 0) {
      rejectionReasons.push('INVALID_BUSINESS_NAME');
      hasValidBusinessInfo = false;
    }

    const { latitude, longitude } = candidate;
    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      Number.isNaN(latitude) ||
      Number.isNaN(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      rejectionReasons.push('INVALID_COORDINATES');
      hasValidBusinessInfo = false;
    }

    const { distanceMeters } = candidate;
    if (
      typeof distanceMeters !== 'number' ||
      Number.isNaN(distanceMeters) ||
      distanceMeters < 0
    ) {
      rejectionReasons.push('INVALID_DISTANCE');
      hasValidBusinessInfo = false;
    }

    if (hasValidBusinessInfo) {
      reasons.push('VALID_BUSINESS_INFO');
    }

    // =========================================================================
    // 2. GEOGRAPHIC ELIGIBILITY CHECK
    // =========================================================================
    const maxRadiusMeters = criteria.maxRadiusMeters ?? 10000;

    if (typeof distanceMeters === 'number' && !Number.isNaN(distanceMeters) && distanceMeters >= 0) {
      if (distanceMeters <= maxRadiusMeters) {
        reasons.push('DISTANCE_WITHIN_RADIUS');
      } else {
        rejectionReasons.push('OUTSIDE_RADIUS');
      }
    }

    // =========================================================================
    // 3. CATEGORY RELEVANCE CHECK
    // =========================================================================
    const categoryMapping = CategoryMappingRegistry.resolve(
      criteria.procurementCategory || criteria.productName
    );

    const catResult = matchSupplierCategories(candidate.categories, categoryMapping);

    if (catResult.outcome === 'CATEGORY_MATCH') {
      reasons.push('CATEGORY_MATCH');
      matchedCategories.push(...catResult.matchedTokens);
    } else if (catResult.outcome === 'CATEGORY_MISMATCH') {
      rejectionReasons.push('CATEGORY_MISMATCH');
    } else {
      reasons.push('CATEGORY_UNKNOWN');
    }

    // =========================================================================
    // 4. CONTACTABILITY CHECK
    // =========================================================================
    const phone = candidate.phone?.trim() || undefined;
    const email = candidate.email?.trim() || undefined;
    const website = candidate.website?.trim() || undefined;
    const hasViableContact = Boolean(phone || email || website);

    const contactChannels = {
      phone,
      email,
      website,
      hasViableContact,
    };

    if (hasViableContact) {
      reasons.push('CONTACT_METHOD_AVAILABLE');
    } else {
      reasons.push('NO_CONTACT_METHOD');
    }

    // =========================================================================
    // 5. DELIVERY / SLA FEASIBILITY CHECK
    // =========================================================================
    const maxSlaHours = criteria.maxSlaHours ?? 12.0;

    // Check for explicit impossible SLA requested
    if (maxSlaHours <= 0) {
      rejectionReasons.push('SLA_IMPOSSIBLE');
    } else if (criteria.deliveryDeadline) {
      const refTime = criteria.referenceTime ?? new Date();
      const hoursRemaining =
        (criteria.deliveryDeadline.getTime() - refTime.getTime()) / (1000 * 3600);
      if (hoursRemaining <= 0) {
        rejectionReasons.push('SLA_IMPOSSIBLE');
      }
    }

    // Turnaround capability evaluation:
    // If supplier has verified turnaround data (e.g. contracted partner or seed mock data):
    if (criteria.verifiedDeliveryHours !== undefined) {
      if (criteria.verifiedDeliveryHours <= maxSlaHours) {
        reasons.push('SLA_FEASIBLE');
      } else {
        rejectionReasons.push('SLA_IMPOSSIBLE');
      }
    } else if (!rejectionReasons.includes('SLA_IMPOSSIBLE')) {
      // NEVER infer delivery time from map distance alone.
      // Un-contacted map candidates strictly require RFQ to verify fulfillment turnaround.
      reasons.push('DELIVERY_CAPABILITY_UNKNOWN');
    }

    // =========================================================================
    // 6. SYNTHESIZE FINAL STATUS
    // =========================================================================
    let status: QualificationStatus;

    if (rejectionReasons.length > 0) {
      status = 'REJECTED';
    } else if (
      reasons.includes('DELIVERY_CAPABILITY_UNKNOWN') ||
      reasons.includes('CATEGORY_UNKNOWN') ||
      reasons.includes('NO_CONTACT_METHOD')
    ) {
      status = 'REQUIRES_RFQ';
    } else {
      status = 'QUALIFIED';
    }

    return {
      candidateId: candidate.id,
      supplierName: candidate.name,
      status,
      reasons: Array.from(new Set([...rejectionReasons, ...reasons])),
      rejectionReasons,
      matchedCategories,
      distanceKm: candidate.distanceKm,
      contactChannels,
      source: candidate.source,
      qualifiedAt: criteria.referenceTime ?? new Date(),
      candidate,
    };
  }

  /**
   * Qualifies an array of discovered candidates against procurement criteria.
   */
  public qualifyCandidates(
    candidates: SupplierCandidate[],
    criteria: SupplierQualificationCriteria
  ): SupplierQualificationResult[] {
    return candidates.map((cand) => this.qualifyCandidate(cand, criteria));
  }

  /**
   * Filters results to strictly fully-qualified candidates.
   */
  public filterQualified(results: SupplierQualificationResult[]): QualifiedSupplier[] {
    return results.filter((r): r is QualifiedSupplier => r.status === 'QUALIFIED');
  }

  /**
   * Filters results to candidates requiring RFQ / supplier contact.
   */
  public filterRequiresRfq(results: SupplierQualificationResult[]): QualifiedSupplier[] {
    return results.filter((r): r is QualifiedSupplier => r.status === 'REQUIRES_RFQ');
  }

  /**
   * Filters results to clearly rejected candidates.
   */
  public filterRejected(results: SupplierQualificationResult[]): SupplierQualificationResult[] {
    return results.filter((r) => r.status === 'REJECTED');
  }
}

export const qualificationService = new DeterministicQualificationService();

