import { randomUUID } from 'crypto';
import { prisma } from '../../config/prisma';
import {
  ProcurementError,
  ProcurementErrorCode,
  addDecimals,
  isDecimalEqual,
  toDecimal,
} from '../../domain/procurement';
import {
  DeliveryStatus,
  DeliveryAllocationStatus,
  CommunityOrderStatus,
  Prisma,
} from '@prisma/client';

export interface AllocationRequest {
  communityOrderId: string;
  allocations: {
    residentOrderId: string;
    productId: string;
    quantity: Prisma.Decimal | number | string;
  }[];
}

export class AllocationService {
  /**
   * Deterministically allocates delivered community batch quantities back to individual resident orders.
   *
   * Verifies that for every product:
   * SUM(individual resident allocated quantities) == CommunityOrderItem total quantity
   *
   * Throws ProcurementError(ALLOCATION_MISMATCH) if there is any quantity discrepancy.
   */
  public async allocateCommunityDelivery(input: AllocationRequest) {
    const communityOrder = await prisma.communityOrder.findUnique({
      where: { id: input.communityOrderId },
      include: {
        items: true,
        residentOrders: {
          include: { items: true },
        },
      },
    });

    if (!communityOrder) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_REQUEST,
        `Community order ${input.communityOrderId} not found`
      );
    }

    // 0. State Machine Invariant: Reject allocation for terminal orders
    if (
      communityOrder.status === CommunityOrderStatus.RECONCILED ||
      communityOrder.status === CommunityOrderStatus.CANCELLED
    ) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_STATE_TRANSITION,
        `Cannot allocate delivery for community order in terminal status '${communityOrder.status}'`
      );
    }

    if (!input.allocations || input.allocations.length === 0) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_REQUEST,
        'Allocation request cannot be empty'
      );
    }

    // Validation: Non-negative quantities, valid products, and valid resident orders
    const validProductIds = new Set(communityOrder.items.map((i) => i.productId));
    const validResidentOrderIds = new Set(communityOrder.residentOrders.map((ro) => ro.id));

    for (const alloc of input.allocations) {
      const qtyDec = toDecimal(alloc.quantity);
      if (qtyDec.lessThanOrEqualTo(0)) {
        throw new ProcurementError(
          ProcurementErrorCode.INVALID_QUANTITY,
          `Allocated quantity must be strictly greater than zero. Received ${alloc.quantity}`
        );
      }
      if (!validProductIds.has(alloc.productId)) {
        throw new ProcurementError(
          ProcurementErrorCode.INVALID_REQUEST,
          `Allocated product '${alloc.productId}' is not part of community order line items`
        );
      }
      if (validResidentOrderIds.size > 0 && !validResidentOrderIds.has(alloc.residentOrderId)) {
        throw new ProcurementError(
          ProcurementErrorCode.INVALID_REQUEST,
          `Resident order '${alloc.residentOrderId}' does not belong to community order '${communityOrder.id}'`
        );
      }
    }

    // 1. Group allocations by product to verify exact sum match against community line items
    const allocatedByProduct = new Map<string, Prisma.Decimal>();
    for (const alloc of input.allocations) {
      const current = allocatedByProduct.get(alloc.productId) ?? new Prisma.Decimal(0);
      allocatedByProduct.set(
        alloc.productId,
        addDecimals(current, toDecimal(alloc.quantity))
      );
    }

    for (const orderItem of communityOrder.items) {
      const allocatedQty =
        allocatedByProduct.get(orderItem.productId) ?? new Prisma.Decimal(0);

      if (!isDecimalEqual(allocatedQty, orderItem.totalQuantity)) {
        throw new ProcurementError(
          ProcurementErrorCode.ALLOCATION_MISMATCH,
          `Allocation mismatch for product ${orderItem.productId}: community total is ${orderItem.totalQuantity}, but sum of resident allocations is ${allocatedQty}`
        );
      }
    }

    // 2. Transactionally persist Delivery and DeliveryAllocation records
    const delivery = await prisma.$transaction(async (tx) => {
      // Upsert delivery record for community order
      const del = await tx.delivery.upsert({
        where: { communityOrderId: communityOrder.id },
        update: {
          status: DeliveryStatus.PREPARING,
        },
        create: {
          communityOrderId: communityOrder.id,
          status: DeliveryStatus.PREPARING,
          trackingCode: `TRK-SIM-${randomUUID().slice(0, 8).toUpperCase()}`,
        },
      });

      // Clear any prior allocations and insert verified allocation records
      await tx.deliveryAllocation.deleteMany({
        where: { deliveryId: del.id },
      });

      for (const a of input.allocations) {
        await tx.deliveryAllocation.create({
          data: {
            deliveryId: del.id,
            residentOrderId: a.residentOrderId,
            productId: a.productId,
            quantity: toDecimal(a.quantity),
            status: DeliveryAllocationStatus.ALLOCATED,
          },
        });
      }

      return tx.delivery.findUnique({
        where: { id: del.id },
        include: {
          allocations: {
            include: { product: true, residentOrder: true },
          },
        },
      });
    });

    return delivery;
  }
}

export const allocationService = new AllocationService();

