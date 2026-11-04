import { randomUUID } from 'crypto';
import {
  addDecimals,
  divideDecimals,
  multiplyDecimals,
  roundMoney,
  toDecimal,
} from '../../../domain/procurement/decimal';
import { Quote } from '../quote/types';
import { ProposedAllocation, SupplierAllocation } from './types';

export interface CalculatedAllocationPlan {
  allocations: SupplierAllocation[];
  financials: {
    subtotal: number;
    deliveryFee: number;
    tax: number;
    otherCharges: number;
    total: number;
    currency: string;
  };
}

export class AllocationService {
  /**
   * Deterministically calculates financial breakdowns for single or multi-supplier allocations
   * using Decimal arithmetic, ensuring zero floating-point drift and strict conservation of funds.
   */
  public calculateAllocations(
    commitmentId: string,
    proposedAllocations: ProposedAllocation[],
    quoteMap: Map<string, Quote>
  ): CalculatedAllocationPlan {
    const allocations: SupplierAllocation[] = [];

    let totalSubtotalDecimal = toDecimal(0);
    let totalDeliveryFeeDecimal = toDecimal(0);
    let totalTaxDecimal = toDecimal(0);
    let totalOtherChargesDecimal = toDecimal(0);
    let grandTotalDecimal = toDecimal(0);

    for (const proposed of proposedAllocations) {
      const quote = quoteMap.get(proposed.quoteId);
      if (!quote) {
        throw new Error(`Quote '${proposed.quoteId}' not found during allocation calculation`);
      }

      const lines = Array.isArray(quote.lineItems) ? quote.lineItems : [];
      const primaryLine = quote.lineItems[0];
      const unit = primaryLine?.unit ?? 'units';

      // 1. Line subtotal extended PER QUOTED LINE, then summed. Single-line
      // quotes follow the exact legacy arithmetic; multi-line quotes must
      // never price the summed quantity at one line's unit price. The scale
      // factor is exactly 1 for full awards and prorates partial (split)
      // awards deterministically. All Decimal — no floating point.
      let lineSubtotalDecimal;
      let unitPrice: number;
      if (lines.length <= 1) {
        unitPrice = primaryLine?.unitPrice ?? 0;
        lineSubtotalDecimal = roundMoney(multiplyDecimals(proposed.quantity, unitPrice));
      } else {
        const totalQuotedQty = lines.reduce((acc, l) => acc + (l.quotedQuantity ?? 0), 0);
        const factor =
          totalQuotedQty > 0 ? divideDecimals(proposed.quantity, totalQuotedQty) : toDecimal(0);
        let extendedSum = toDecimal(0);
        for (const line of lines) {
          const lineExtended = roundMoney(
            multiplyDecimals(line.quotedQuantity ?? 0, line.unitPrice ?? 0)
          );
          extendedSum = addDecimals(extendedSum, multiplyDecimals(lineExtended, factor));
        }
        lineSubtotalDecimal = roundMoney(extendedSum);
        // Blended record rate so quantity × agreedUnitPrice tracks the true
        // multi-line subtotal on downstream records (single-line keeps the
        // exact quoted price above).
        unitPrice =
          proposed.quantity > 0
            ? roundMoney(divideDecimals(lineSubtotalDecimal, proposed.quantity)).toNumber()
            : 0;
      }

      // 2. Delivery fee & charges for this supplier allocation
      // If split order, each supplier charges their quoted delivery fee and tax
      const deliveryFeeDecimal = roundMoney(toDecimal(quote.deliveryFee ?? 0));
      const taxDecimal = roundMoney(toDecimal(quote.tax ?? 0));
      const otherChargesDecimal = roundMoney(toDecimal(quote.otherCharges ?? 0));

      // 3. Allocation total = lineSubtotal + deliveryFee + tax + otherCharges
      const allocationTotalDecimal = roundMoney(
        addDecimals(
          lineSubtotalDecimal,
          deliveryFeeDecimal,
          taxDecimal,
          otherChargesDecimal
        )
      );

      const allocation: SupplierAllocation = {
        id: `alloc_${randomUUID().slice(0, 8)}`,
        commitmentId,
        supplierId: proposed.supplierId,
        supplierName: quote.supplierName,
        quoteId: quote.id,
        allocatedQuantity: proposed.quantity,
        unit,
        agreedUnitPrice: unitPrice,
        lineSubtotal: lineSubtotalDecimal.toNumber(),
        deliveryFee: deliveryFeeDecimal.toNumber(),
        tax: taxDecimal.toNumber(),
        otherCharges: otherChargesDecimal.toNumber(),
        totalAmount: allocationTotalDecimal.toNumber(),
        deliveryEtaHours: quote.deliveryEtaHours,
        confirmedDeliveryEta: quote.confirmedDeliveryEta,
      };

      allocations.push(allocation);

      totalSubtotalDecimal = addDecimals(totalSubtotalDecimal, lineSubtotalDecimal);
      totalDeliveryFeeDecimal = addDecimals(totalDeliveryFeeDecimal, deliveryFeeDecimal);
      totalTaxDecimal = addDecimals(totalTaxDecimal, taxDecimal);
      totalOtherChargesDecimal = addDecimals(totalOtherChargesDecimal, otherChargesDecimal);
      grandTotalDecimal = addDecimals(grandTotalDecimal, allocationTotalDecimal);
    }

    return {
      allocations,
      financials: {
        subtotal: roundMoney(totalSubtotalDecimal).toNumber(),
        deliveryFee: roundMoney(totalDeliveryFeeDecimal).toNumber(),
        tax: roundMoney(totalTaxDecimal).toNumber(),
        otherCharges: roundMoney(totalOtherChargesDecimal).toNumber(),
        total: roundMoney(grandTotalDecimal).toNumber(),
        currency: 'INR',
      },
    };
  }
}

export const allocationService = new AllocationService();

