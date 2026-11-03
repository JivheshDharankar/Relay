import { prisma } from '../../config/prisma';
import {
  ProcurementError,
  ProcurementErrorCode,
  multiplyDecimals,
  roundMoney,
  toDecimal,
  addDecimals,
  validateCommunityOrderTransition,
  validateResidentOrderTransition,
} from '../../domain/procurement';
import {
  AuditEventType,
  CommunityOrderStatus,
  ResidentOrderStatus,
  Prisma,
} from '@prisma/client';

export interface CreateCommunityOrderInput {
  societyId: string;
  supplierId: string;
  deliveryDeadline: Date;
  idempotencyKey?: string;
  items: {
    productId: string;
    totalQuantity: Prisma.Decimal | number | string;
    negotiatedUnitPrice: Prisma.Decimal | number | string;
  }[];
  contributingResidentOrderIds?: string[];
}

export class OrderService {
  /**
   * Deterministically and transactionally creates a consolidated CommunityOrder.
   *
   * Guarantees:
   * 1. Delivery deadline satisfies 12-hour SLA constraint
   * 2. Totals calculated deterministically from items (never caller-provided)
   * 3. Idempotent: duplicate calls with same idempotencyKey return the existing order
   * 4. Atomic: created inside a single Prisma database transaction
   * 5. Updates contributing ResidentOrders to AGGREGATING / PROCURED
   */
  public async createCommunityOrder(input: CreateCommunityOrderInput) {
    // 1. Idempotency Check
    if (input.idempotencyKey) {
      const existing = await prisma.communityOrder.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: {
          items: { include: { product: true } },
          residentOrders: true,
          supplier: true,
          society: true,
        },
      });
      if (existing) {
        return { order: existing, isDuplicate: true };
      }
    }

    // 2. Validate SLA: deliveryDeadline <= now + 12 hours
    const maxAllowedDeadline = new Date(Date.now() + 12 * 3600 * 1000 + 60000); // 12h + 1m buffer
    if (input.deliveryDeadline.getTime() > maxAllowedDeadline.getTime()) {
      throw new ProcurementError(
        ProcurementErrorCode.SLA_VIOLATION,
        `Delivery deadline exceeds the mandatory 12-hour Relay fulfillment SLA`
      );
    }

    // 3. Verify Society & Supplier existence
    const [society, supplier] = await Promise.all([
      prisma.society.findUnique({ where: { id: input.societyId } }),
      prisma.supplier.findUnique({ where: { id: input.supplierId } }),
    ]);

    if (!society) {
      throw new ProcurementError(
        ProcurementErrorCode.SOCIETY_MISMATCH,
        `Society ${input.societyId} not found`
      );
    }
    if (!supplier) {
      throw new ProcurementError(
        ProcurementErrorCode.NO_ELIGIBLE_SUPPLIER,
        `Supplier ${input.supplierId} not found`
      );
    }

    if (input.items.length === 0) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_REQUEST,
        'Cannot create a community order with zero items'
      );
    }

    // 4. Deterministic Line Item & Total Price Calculations
    let computedTotalAmount = new Prisma.Decimal(0);
    const preparedItems = input.items.map((item) => {
      const qty = toDecimal(item.totalQuantity);
      const unitPrice = toDecimal(item.negotiatedUnitPrice);
      const totalPrice = roundMoney(multiplyDecimals(qty, unitPrice));
      computedTotalAmount = addDecimals(computedTotalAmount, totalPrice);

      return {
        productId: item.productId,
        totalQuantity: qty,
        negotiatedUnitPrice: unitPrice,
        totalPrice,
      };
    });

    // 5. Execute Atomic Database Transaction
    try {
      const createdOrder = await prisma.$transaction(async (tx) => {
        const order = await tx.communityOrder.create({
          data: {
            idempotencyKey: input.idempotencyKey,
            societyId: input.societyId,
            supplierId: input.supplierId,
            status: CommunityOrderStatus.CREATED,
            totalAmount: computedTotalAmount,
            currency: 'INR',
            deliveryDeadline: input.deliveryDeadline,
            items: {
              create: preparedItems,
            },
          },
          include: {
            items: { include: { product: true } },
            supplier: true,
            society: true,
          },
        });

        // Link contributing resident orders and transition their state
        if (input.contributingResidentOrderIds && input.contributingResidentOrderIds.length > 0) {
          const negotiatedPriceMap = new Map<string, Prisma.Decimal>();
          for (const item of preparedItems) {
            negotiatedPriceMap.set(item.productId, item.negotiatedUnitPrice);
          }

          for (const residentOrderId of input.contributingResidentOrderIds) {
            const resOrder = await tx.residentOrder.findUnique({
              where: { id: residentOrderId },
              include: { items: true },
            });
            if (resOrder) {
              validateResidentOrderTransition(
                resOrder.status,
                ResidentOrderStatus.PROCURED
              );

              // Synchronize OrderItem prices and ResidentOrder totalAmount to winning negotiated price
              let updatedResidentTotal = new Prisma.Decimal(0);
              for (const item of resOrder.items) {
                const negotiatedUnitPrice = negotiatedPriceMap.get(item.productId);
                if (negotiatedUnitPrice !== undefined) {
                  const updatedTotalPrice = roundMoney(
                    multiplyDecimals(item.quantity, negotiatedUnitPrice)
                  );
                  await tx.orderItem.update({
                    where: { id: item.id },
                    data: {
                      unitPrice: negotiatedUnitPrice,
                      totalPrice: updatedTotalPrice,
                    },
                  });
                  updatedResidentTotal = addDecimals(
                    updatedResidentTotal,
                    updatedTotalPrice
                  );
                } else {
                  updatedResidentTotal = addDecimals(
                    updatedResidentTotal,
                    item.totalPrice
                  );
                }
              }

              await tx.residentOrder.update({
                where: { id: residentOrderId },
                data: {
                  communityOrderId: order.id,
                  status: ResidentOrderStatus.PROCURED,
                  totalAmount: updatedResidentTotal,
                },
              });
            }
          }
        }

        // Record ORDER_CREATED operational audit event
        await tx.auditEvent.create({
          data: {
            eventType: AuditEventType.ORDER_CREATED,
            actor: 'deterministic_core:order_service',
            entityType: 'CommunityOrder',
            entityId: order.id,
            metadata: {
              societyId: order.societyId,
              supplierId: order.supplierId,
              totalAmount: Number(order.totalAmount),
              deliveryDeadline: order.deliveryDeadline.toISOString(),
              itemsCount: preparedItems.length,
              contributingResidentOrders: input.contributingResidentOrderIds ?? [],
            },
          },
        });

        return order;
      });

      return { order: createdOrder, isDuplicate: false };
    } catch (err: any) {
      if (input.idempotencyKey && (err.code === 'P2002' || err.message?.includes('idempotencyKey'))) {
        const existing = await prisma.communityOrder.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          include: {
            items: { include: { product: true } },
            residentOrders: true,
            supplier: true,
            society: true,
          },
        });
        if (existing) {
          return { order: existing, isDuplicate: true };
        }
      }
      throw err;
    }
  }

  /**
   * Advances the status of a CommunityOrder through the valid state machine.
   */
  public async transitionCommunityOrderStatus(
    orderId: string,
    nextStatus: CommunityOrderStatus
  ) {
    const order = await prisma.communityOrder.findUnique({
      where: { id: orderId },
    });
    if (!order) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_REQUEST,
        `Community order ${orderId} not found`
      );
    }

    validateCommunityOrderTransition(order.status, nextStatus);

    return prisma.communityOrder.update({
      where: { id: orderId },
      data: { status: nextStatus },
    });
  }
}

export const orderService = new OrderService();

