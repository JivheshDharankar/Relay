import {
  isDecimalEqual,
  roundMoney,
  toDecimal,
} from '../domain/procurement/decimal';
import { QuantityAllocationResultItem } from './AllocationEngine';
import { AllocationValidationError, validateMonetaryConservation, validateNonNegativity } from './validation';

export interface ProcurementFinancialsInput {
  unitPrice?: number;
  subtotal: number;
  tax: number;
  deliveryFee: number;
  otherCharges: number;
  total: number;
  currency?: string;
}

export interface ResidentCostItem {
  residentOrderId: string;
  /**
   * Per-line demand key carried through from quantity allocation. Always
   * populated by the pipeline; optional only for backward compatibility
   * with previously constructed items.
   */
  demandLineId?: string;
  residentReference: string;
  requestedQuantity: number;
  allocatedQuantity: number;
  unitPrice: number;
  subtotal: number;
  allocatedTax: number;
  allocatedDeliveryFee: number;
  allocatedOtherCharges: number;
  totalAmount: number;
}

export class CostAllocationService {
  /**
   * Deterministically calculates financial obligations per resident based on fulfilled quantities.
   *
   * Enforces:
   * 1. Exact Decimal arithmetic (INR 2 decimal places / paise precision).
   * 2. Zero paise leakage: SUM(resident amounts) == authoritative total procurement cost.
   * 3. Line-item integrity: resident.total == subtotal + tax + delivery + other.
   * 4. Residual paise allocation applied deterministically to the largest share.
   */
  public allocateCosts(
    quantityAllocations: QuantityAllocationResultItem[],
    financials: ProcurementFinancialsInput
  ): ResidentCostItem[] {
    const totalAllocated = quantityAllocations.reduce(
      (sum, item) => sum + item.allocatedQuantity,
      0
    );

    // Validate authoritative procurement cost integrity: total == subtotal + tax + deliveryFee + otherCharges
    const authoritativeSubtotal = toDecimal(financials.subtotal);
    const authoritativeTax = toDecimal(financials.tax);
    const authoritativeDelivery = toDecimal(financials.deliveryFee);
    const authoritativeOther = toDecimal(financials.otherCharges);
    const authoritativeTotal = toDecimal(financials.total);

    const calculatedTotal = authoritativeSubtotal
      .plus(authoritativeTax)
      .plus(authoritativeDelivery)
      .plus(authoritativeOther);

    if (!isDecimalEqual(calculatedTotal, authoritativeTotal)) {
      throw new AllocationValidationError([
        `INVALID_FINANCIAL_INPUT: Procurement components (subtotal: ${authoritativeSubtotal}, tax: ${authoritativeTax}, delivery: ${authoritativeDelivery}, other: ${authoritativeOther}) sum to ₹${calculatedTotal.toString()}, which does not match total ₹${authoritativeTotal.toString()}`,
      ]);
    }

    // Zero allocation case (e.g. supplier fulfillment failed completely)
    if (totalAllocated === 0 || quantityAllocations.length === 0) {
      return quantityAllocations.map((item) => ({
        residentOrderId: item.residentOrderId,
        demandLineId: item.demandLineId ?? item.residentOrderId,
        residentReference: item.residentReference,
        requestedQuantity: item.requestedQuantity,
        allocatedQuantity: 0,
        unitPrice: financials.unitPrice || 0,
        subtotal: 0,
        allocatedTax: 0,
        allocatedDeliveryFee: 0,
        allocatedOtherCharges: 0,
        totalAmount: 0,
      }));
    }

    const decTotalAllocated = toDecimal(totalAllocated);

    // Proportional breakdown per resident
    const preliminaryItems = quantityAllocations.map((item) => {
      const decAlloc = toDecimal(item.allocatedQuantity);
      const share = decAlloc.dividedBy(decTotalAllocated);

      const subtotal = roundMoney(authoritativeSubtotal.times(share));
      const allocatedTax = roundMoney(authoritativeTax.times(share));
      const allocatedDeliveryFee = roundMoney(authoritativeDelivery.times(share));
      const allocatedOtherCharges = roundMoney(authoritativeOther.times(share));

      const unitPrice =
        financials.unitPrice !== undefined
          ? financials.unitPrice
          : item.allocatedQuantity > 0
          ? roundMoney(subtotal.dividedBy(decAlloc)).toNumber()
          : 0;

      return {
        residentOrderId: item.residentOrderId,
        demandLineId: item.demandLineId ?? item.residentOrderId,
        residentReference: item.residentReference,
        requestedQuantity: item.requestedQuantity,
        allocatedQuantity: item.allocatedQuantity,
        unitPrice,
        subtotalDec: subtotal,
        taxDec: allocatedTax,
        deliveryDec: allocatedDeliveryFee,
        otherDec: allocatedOtherCharges,
      };
    });

    // Residual paise reconciliation for each cost component
    const sumSubtotal = preliminaryItems.reduce((acc, i) => acc.plus(i.subtotalDec), toDecimal(0));
    const sumTax = preliminaryItems.reduce((acc, i) => acc.plus(i.taxDec), toDecimal(0));
    const sumDelivery = preliminaryItems.reduce((acc, i) => acc.plus(i.deliveryDec), toDecimal(0));
    const sumOther = preliminaryItems.reduce((acc, i) => acc.plus(i.otherDec), toDecimal(0));

    const diffSubtotal = authoritativeSubtotal.minus(sumSubtotal);
    const diffTax = authoritativeTax.minus(sumTax);
    const diffDelivery = authoritativeDelivery.minus(sumDelivery);
    const diffOther = authoritativeOther.minus(sumOther);

    // Identify target resident for residual paise: largest allocation, tie-breaker: stable residentOrderId
    const sortedForResidual = [...preliminaryItems].sort((a, b) => {
      const diff = b.allocatedQuantity - a.allocatedQuantity;
      if (Math.abs(diff) > 1e-9) return diff;
      return a.residentOrderId.localeCompare(b.residentOrderId);
    });

    if (sortedForResidual.length > 0) {
      const target = sortedForResidual[0];
      if (!diffSubtotal.isZero()) target.subtotalDec = target.subtotalDec.plus(diffSubtotal);
      if (!diffTax.isZero()) target.taxDec = target.taxDec.plus(diffTax);
      if (!diffDelivery.isZero()) target.deliveryDec = target.deliveryDec.plus(diffDelivery);
      if (!diffOther.isZero()) target.otherDec = target.otherDec.plus(diffOther);
    }

    // Assemble final resident cost records
    const finalResults: ResidentCostItem[] = preliminaryItems.map((item) => {
      const totalResidentDec = item.subtotalDec
        .plus(item.taxDec)
        .plus(item.deliveryDec)
        .plus(item.otherDec);

      validateNonNegativity({
        subtotal: item.subtotalDec,
        allocatedTax: item.taxDec,
        allocatedDeliveryFee: item.deliveryDec,
        allocatedOtherCharges: item.otherDec,
        totalAmount: totalResidentDec,
      });

      return {
        residentOrderId: item.residentOrderId,
        demandLineId: item.demandLineId,
        residentReference: item.residentReference,
        requestedQuantity: item.requestedQuantity,
        allocatedQuantity: item.allocatedQuantity,
        unitPrice: item.unitPrice,
        subtotal: item.subtotalDec.toNumber(),
        allocatedTax: item.taxDec.toNumber(),
        allocatedDeliveryFee: item.deliveryDec.toNumber(),
        allocatedOtherCharges: item.otherDec.toNumber(),
        totalAmount: totalResidentDec.toNumber(),
      };
    });

    // Final total conservation invariant
    const totalResidentSum = finalResults.reduce(
      (acc, item) => acc.plus(toDecimal(item.totalAmount)),
      toDecimal(0)
    );
    validateMonetaryConservation(totalResidentSum, authoritativeTotal);

    return finalResults;
  }
}

export const costAllocationService = new CostAllocationService();
