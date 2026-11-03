import { prisma } from '../../config/prisma';
import {
  ReconciliationReport,
  addDecimals,
  subtractDecimals,
  multiplyDecimals,
  roundMoney,
  isDecimalEqual,
  ProcurementError,
  ProcurementErrorCode,
  validateCommunityOrderTransition,
} from '../../domain/procurement';
import { AuditEventType, CommunityOrderStatus, Prisma } from '@prisma/client';

export class ReconciliationService {
  /**
   * Performs rigorous deterministic multi-dimensional reconciliation for a CommunityOrder:
   * 1. Quantity reconciliation across all line items
   * 2. Financial reconciliation (Resident order sum vs Community Order invoice)
   * 3. Product integrity
   * 4. Society boundary integrity
   */
  public async reconcileCommunityOrder(
    communityOrderId: string
  ): Promise<ReconciliationReport> {
    const communityOrder = await prisma.communityOrder.findUnique({
      where: { id: communityOrderId },
      include: {
        items: { include: { product: true } },
        delivery: {
          include: {
            allocations: {
              include: { product: true, residentOrder: true },
            },
          },
        },
        residentOrders: {
          include: { items: true },
        },
      },
    });

    if (!communityOrder) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_REQUEST,
        `Community order ${communityOrderId} not found`
      );
    }

    const discrepancies: string[] = [];

    // 1. Quantity Reconciliation
    let totalCommunityQty = new Prisma.Decimal(0);
    let totalAllocatedQty = new Prisma.Decimal(0);

    const communityQtyMap = new Map<string, Prisma.Decimal>();
    for (const item of communityOrder.items) {
      communityQtyMap.set(item.productId, item.totalQuantity);
      totalCommunityQty = addDecimals(totalCommunityQty, item.totalQuantity);
    }

    const allocatedQtyMap = new Map<string, Prisma.Decimal>();
    const allocations = communityOrder.delivery?.allocations ?? [];

    for (const alloc of allocations) {
      const curr = allocatedQtyMap.get(alloc.productId) ?? new Prisma.Decimal(0);
      allocatedQtyMap.set(alloc.productId, addDecimals(curr, alloc.quantity));
      totalAllocatedQty = addDecimals(totalAllocatedQty, alloc.quantity);
    }

    for (const [productId, commQty] of communityQtyMap.entries()) {
      const allocQty = allocatedQtyMap.get(productId) ?? new Prisma.Decimal(0);
      if (!isDecimalEqual(commQty, allocQty)) {
        discrepancies.push(
          `Quantity mismatch on product ${productId}: community order has ${commQty}, but allocations total ${allocQty}`
        );
      }
    }

    const quantityPassed =
      discrepancies.length === 0 &&
      isDecimalEqual(totalCommunityQty, totalAllocatedQty);

    // 2. Financial Reconciliation: Community order total vs contributing resident order totals
    let residentTotalSum = new Prisma.Decimal(0);
    for (const ro of communityOrder.residentOrders) {
      residentTotalSum = addDecimals(residentTotalSum, ro.totalAmount);
    }

    // Check financial reconciliation against community order
    const financialDiff = subtractDecimals(
      communityOrder.totalAmount,
      residentTotalSum
    );
    const financialPassed = isDecimalEqual(
      communityOrder.totalAmount,
      residentTotalSum
    );

    if (!financialPassed) {
      discrepancies.push(
        `Financial mismatch: community invoice is ₹${communityOrder.totalAmount}, but resident orders sum to ₹${residentTotalSum} (diff: ₹${financialDiff})`
      );
    }

    // 3. Product Integrity
    const productDiscrepancies: string[] = [];
    for (const alloc of allocations) {
      if (!communityQtyMap.has(alloc.productId)) {
        productDiscrepancies.push(
          `Allocated product ${alloc.productId} is not part of community order line items`
        );
      }
    }
    const productPassed = productDiscrepancies.length === 0;
    discrepancies.push(...productDiscrepancies);

    // 4. Society Boundary Integrity
    let societyPassed = true;
    for (const ro of communityOrder.residentOrders) {
      if (ro.societyId !== communityOrder.societyId) {
        societyPassed = false;
        discrepancies.push(
          `Society mismatch: ResidentOrder ${ro.id} belongs to society ${ro.societyId}, but community order is ${communityOrder.societyId}`
        );
      }
    }

    // 5. Line Item Unit Price Verification
    for (const item of communityOrder.items) {
      const expectedLineTotal = roundMoney(multiplyDecimals(item.totalQuantity, item.negotiatedUnitPrice));
      if (!isDecimalEqual(expectedLineTotal, item.totalPrice)) {
        discrepancies.push(
          `Line item price mismatch on product ${item.productId}: total ₹${item.totalPrice} does not equal qty ${item.totalQuantity} * unitPrice ₹${item.negotiatedUnitPrice}`
        );
      }
    }

    const isReconciled =
      quantityPassed && financialPassed && productPassed && societyPassed && discrepancies.length === 0;

    const report: ReconciliationReport = {
      isReconciled,
      communityOrderId,
      status: isReconciled ? 'RECONCILED' : 'FAILED',
      quantityReconciliation: {
        passed: quantityPassed,
        communityTotal: totalCommunityQty,
        residentSum: totalAllocatedQty,
        difference: subtractDecimals(totalCommunityQty, totalAllocatedQty),
      },
      financialReconciliation: {
        passed: financialPassed,
        communityTotal: communityOrder.totalAmount,
        residentSum: residentTotalSum,
        difference: financialDiff,
      },
      productIntegrity: {
        passed: productPassed,
        discrepancies: productDiscrepancies,
      },
      societyIntegrity: {
        passed: societyPassed,
        societyId: communityOrder.societyId,
      },
      discrepancies,
    };

    if (isReconciled) {
      // Transition state to RECONCILED if it was DELIVERED
      if (communityOrder.status === CommunityOrderStatus.DELIVERED) {
        validateCommunityOrderTransition(
          communityOrder.status,
          CommunityOrderStatus.RECONCILED
        );
        await prisma.communityOrder.update({
          where: { id: communityOrderId },
          data: { status: CommunityOrderStatus.RECONCILED },
        });
      }

      await prisma.auditEvent.create({
        data: {
          eventType: AuditEventType.RECONCILED,
          actor: 'deterministic_core:reconciliation_service',
          entityType: 'CommunityOrder',
          entityId: communityOrderId,
          metadata: {
            communityOrderId,
            reconciled: true,
            totalQuantity: Number(totalCommunityQty),
            totalAmount: Number(communityOrder.totalAmount),
            allocationsCount: allocations.length,
          },
        },
      });
    } else {
      await prisma.auditEvent.create({
        data: {
          eventType: AuditEventType.RECONCILED,
          actor: 'deterministic_core:reconciliation_service',
          entityType: 'CommunityOrder',
          entityId: communityOrderId,
          metadata: {
            communityOrderId,
            reconciled: false,
            discrepancies,
          },
        },
      });
    }

    return report;
  }
}

export const reconciliationService = new ReconciliationService();

