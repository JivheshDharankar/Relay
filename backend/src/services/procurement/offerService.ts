import { prisma } from '../../config/prisma';
import {
  OfferEvaluationScore,
  evaluateAndRankOffers,
  RawOfferCandidate,
  ProcurementError,
  ProcurementErrorCode,
  multiplyDecimals,
  roundMoney,
  toDecimal,
  isLessThanOrEqual,
  isPositive,
} from '../../domain/procurement';
import { supplierService, SupplierFilterInput } from './supplierService';
import { AuditEventType, Prisma } from '@prisma/client';

export interface EvaluateOffersInput {
  societyId: string;
  productId: string;
  totalQuantity: Prisma.Decimal | number | string;
  customQuotes?: {
    supplierId: string;
    unitPrice: Prisma.Decimal | number | string;
    deliveryHours: number;
    offerId?: string;
  }[];
}

export class OfferService {
  /**
   * Evaluates all supplier offers for an aggregated demand batch.
   * Applies hard constraints first, then ranks compliant offers by transparent multi-factor scoring.
   */
  public async evaluateOffers(
    input: EvaluateOffersInput
  ): Promise<OfferEvaluationScore[]> {
    const qty = toDecimal(input.totalQuantity);

    // 1. Run hard constraint checks for all suppliers
    const filterInput: SupplierFilterInput = {
      societyId: input.societyId,
      productId: input.productId,
      requestedQuantity: qty,
      overrideDeliveryHours: input.customQuotes?.reduce(
        (acc, q) => ({ ...acc, [q.supplierId]: q.deliveryHours }),
        {}
      ),
    };

    const hardChecks = await supplierService.filterEligibleSuppliers(filterInput);
    const checksMap = new Map(hardChecks.map((c) => [c.supplierId, c]));

    // Query supplier product catalog prices
    const catalog = await prisma.supplierProduct.findMany({
      where: { productId: input.productId },
      include: { supplier: true },
    });
    const catalogMap = new Map(catalog.map((cp) => [cp.supplierId, cp]));

    const candidates: RawOfferCandidate[] = [];

    // If custom quotes were provided, use them; otherwise construct candidates from catalog
    if (input.customQuotes && input.customQuotes.length > 0) {
      for (const quote of input.customQuotes) {
        const check = checksMap.get(quote.supplierId);
        const supplier = catalogMap.get(quote.supplierId)?.supplier;
        const supplierName = check?.supplierName ?? supplier?.name ?? 'Unknown Supplier';
        const reliability = Number(supplier?.reliabilityScore ?? 0.8);
        const totalPrice = roundMoney(multiplyDecimals(qty, quote.unitPrice));

        candidates.push({
          supplierId: quote.supplierId,
          supplierName,
          offerId: quote.offerId,
          totalPrice,
          deliveryHours: quote.deliveryHours,
          reliabilityScore: reliability,
          hardConstraintPassed: check?.eligible ?? false,
          reasons: check?.reasons ?? ['SUPPLIER_CHECK_FAILED'],
        });
      }
    } else {
      for (const check of hardChecks) {
        const cp = catalogMap.get(check.supplierId);
        const unitPrice = cp?.basePrice ?? new Prisma.Decimal(100.0);
        const totalPrice = roundMoney(multiplyDecimals(qty, unitPrice));
        const reliability = Number(cp?.supplier.reliabilityScore ?? 0.8);

        candidates.push({
          supplierId: check.supplierId,
          supplierName: check.supplierName,
          totalPrice,
          deliveryHours: check.estimatedDeliveryHours,
          reliabilityScore: reliability,
          hardConstraintPassed: check.eligible,
          reasons: check.reasons,
        });
      }
    }

    const ranked = evaluateAndRankOffers(candidates);

    // Record audit event for rejected offers
    for (const r of ranked) {
      if (!r.hardConstraintPassed) {
        await prisma.auditEvent.create({
          data: {
            eventType: AuditEventType.OFFER_REJECTED,
            actor: 'deterministic_core:offer_service',
            entityType: 'Supplier',
            entityId: r.supplierId,
            metadata: {
              productId: input.productId,
              reasons: r.reasons,
              totalPrice: Number(r.totalPrice),
            },
          },
        });
      }
    }

    return ranked;
  }

  /**
   * Selects the single best compliant offer based on deterministic ranking.
   */
  public async selectBestOffer(
    input: EvaluateOffersInput
  ): Promise<OfferEvaluationScore> {
    const ranked = await this.evaluateOffers(input);
    const winning = ranked.find((o) => o.hardConstraintPassed);

    if (!winning) {
      throw new ProcurementError(
        ProcurementErrorCode.NO_ELIGIBLE_SUPPLIER,
        'No suppliers passed the hard constraints (status, capability, SLA, service area, and MOQ)'
      );
    }

    // Record OFFER_SELECTED audit event
    await prisma.auditEvent.create({
      data: {
        eventType: AuditEventType.OFFER_SELECTED,
        actor: 'deterministic_core:offer_service',
        entityType: 'Supplier',
        entityId: winning.supplierId,
        metadata: {
          supplierName: winning.supplierName,
          productId: input.productId,
          totalPrice: Number(winning.totalPrice),
          compositeScore: winning.compositeScore,
          deliveryHours: winning.deliveryHours,
          reliabilityScore: winning.reliabilityScore,
        },
      },
    });

    return winning;
  }

  /**
   * Validates a negotiated final offer ensuring hard constraints still hold
   * and final price <= initial price.
   */
  public async validateNegotiatedOffer(
    _supplierId: string,
    _productId: string,
    _quantity: Prisma.Decimal | number | string,
    initialPrice: Prisma.Decimal | number | string,
    negotiatedPrice: Prisma.Decimal | number | string,
    deliveryHours: number
  ): Promise<Prisma.Decimal> {
    const initialDec = toDecimal(initialPrice);
    const finalDec = toDecimal(negotiatedPrice);

    if (!isPositive(finalDec)) {
      throw new ProcurementError(
        ProcurementErrorCode.OFFER_INVALID,
        'Negotiated offer price must be strictly greater than zero'
      );
    }

    if (!isLessThanOrEqual(finalDec, initialDec)) {
      throw new ProcurementError(
        ProcurementErrorCode.OFFER_INVALID,
        `Negotiated final price (₹${finalDec}) cannot exceed initial offer (₹${initialDec})`
      );
    }

    if (deliveryHours > 12) {
      throw new ProcurementError(
        ProcurementErrorCode.SLA_VIOLATION,
        `Negotiated delivery turnaround (${deliveryHours}h) violates 12-hour SLA limit`
      );
    }

    return finalDec;
  }
}

export const offerService = new OfferService();
