import { Prisma } from '@prisma/client';
import { OfferEvaluationScore } from './types';
import { isLessThan } from './decimal';

export interface RawOfferCandidate {
  supplierId: string;
  supplierName: string;
  offerId?: string;
  totalPrice: Prisma.Decimal;
  deliveryHours: number;
  reliabilityScore: number;
  hardConstraintPassed: boolean;
  reasons: string[];
}

export const EVALUATION_WEIGHTS = {
  PRICE: 0.5,
  RELIABILITY: 0.3,
  DELIVERY_SPEED: 0.2,
} as const;

/**
 * Deterministically evaluates and scores supplier offers.
 *
 * Ranking Rule:
 * 1. Hard constraints are applied FIRST. Ineligible offers receive a score of 0.0
 *    and can NEVER win over eligible offers.
 * 2. Eligible offers are scored using a normalized composite formula:
 *    Score = (w_price * PriceScore) + (w_reliability * ReliabilityScore) + (w_delivery * DeliveryScore)
 *    - PriceScore: minPrice / offerPrice (higher is cheaper/better)
 *    - ReliabilityScore: supplier reliability [0.0 - 1.0]
 *    - DeliveryScore: max(0, (12 - deliveryHours) / 12) (faster within 12h SLA is better)
 */
export function evaluateAndRankOffers(
  candidates: RawOfferCandidate[]
): OfferEvaluationScore[] {
  if (candidates.length === 0) return [];

  // Filter eligible offers to find minimum price for relative scaling
  const eligibleCandidates = candidates.filter((c) => c.hardConstraintPassed);

  let minPrice = new Prisma.Decimal(Infinity);
  for (const c of eligibleCandidates) {
    if (isLessThan(c.totalPrice, minPrice)) {
      minPrice = c.totalPrice;
    }
  }

  const scoredOffers: OfferEvaluationScore[] = candidates.map((candidate) => {
    if (!candidate.hardConstraintPassed) {
      return {
        supplierId: candidate.supplierId,
        supplierName: candidate.supplierName,
        offerId: candidate.offerId,
        totalPrice: candidate.totalPrice,
        deliveryHours: candidate.deliveryHours,
        reliabilityScore: candidate.reliabilityScore,
        hardConstraintPassed: false,
        reasons: candidate.reasons,
        compositeScore: 0.0,
        breakdown: {
          priceScore: 0.0,
          reliabilityScore: 0.0,
          deliveryScore: 0.0,
        },
      };
    }

    // Normalized Price Score: 1.0 for cheapest, scaled down for higher prices
    const priceNum = Number(candidate.totalPrice);
    const minPriceNum = Number(minPrice);
    const priceScore = priceNum > 0 ? Math.min(1.0, minPriceNum / priceNum) : 1.0;

    // Normalized Reliability Score: directly in [0, 1]
    const reliabilityScore = Math.min(1.0, Math.max(0.0, candidate.reliabilityScore));

    // Normalized Delivery Score: 1.0 for immediate delivery, scaling down to 0 at 12 hours SLA limit
    const deliveryScore = Math.max(0.0, Math.min(1.0, (12 - candidate.deliveryHours) / 12));

    const compositeScore =
      EVALUATION_WEIGHTS.PRICE * priceScore +
      EVALUATION_WEIGHTS.RELIABILITY * reliabilityScore +
      EVALUATION_WEIGHTS.DELIVERY_SPEED * deliveryScore;

    return {
      supplierId: candidate.supplierId,
      supplierName: candidate.supplierName,
      offerId: candidate.offerId,
      totalPrice: candidate.totalPrice,
      deliveryHours: candidate.deliveryHours,
      reliabilityScore: candidate.reliabilityScore,
      hardConstraintPassed: true,
      reasons: [],
      compositeScore: Math.round(compositeScore * 10000) / 10000,
      breakdown: {
        priceScore: Math.round(priceScore * 10000) / 10000,
        reliabilityScore: Math.round(reliabilityScore * 10000) / 10000,
        deliveryScore: Math.round(deliveryScore * 10000) / 10000,
      },
    };
  });

  // Sort: Eligible first, then highest compositeScore, then lowest totalPrice, then stable ID
  return scoredOffers.sort((a, b) => {
    if (a.hardConstraintPassed !== b.hardConstraintPassed) {
      return a.hardConstraintPassed ? -1 : 1;
    }
    if (b.compositeScore !== a.compositeScore) {
      return b.compositeScore - a.compositeScore;
    }
    const priceDiff = Number(a.totalPrice.minus(b.totalPrice));
    if (priceDiff !== 0) {
      return priceDiff;
    }
    return a.supplierId.localeCompare(b.supplierId);
  });
}

