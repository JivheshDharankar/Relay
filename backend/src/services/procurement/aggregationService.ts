import { prisma } from '../../config/prisma';
import {
  AggregatedDemandGroup,
  SupplierFacingDemand,
  addDecimals,
  ProcurementError,
  ProcurementErrorCode,
} from '../../domain/procurement';
import { AuditEventType, ResidentOrderStatus } from '@prisma/client';

export class AggregationService {
  /**
   * Deterministically aggregates compatible pending resident demands within a specific society.
   *
   * Compatibility rules:
   * 1. Strictly within the same society (never across different communities)
   * 2. Grouped by product ID and product unit
   * 3. Orders must be in PENDING status
   *
   * Privacy boundary:
   * Returns internal demand groups with resident IDs for allocation tracking,
   * alongside clean, anonymous supplier-facing representations with zero resident identities.
   */
  public async aggregateSocietyDemand(
    societyId: string,
    orderIds?: string[]
  ): Promise<{
    internalGroups: AggregatedDemandGroup[];
    supplierFacingGroups: SupplierFacingDemand[];
  }> {
    const society = await prisma.society.findUnique({
      where: { id: societyId },
    });
    if (!society) {
      throw new ProcurementError(
        ProcurementErrorCode.SOCIETY_MISMATCH,
        `Society with ID ${societyId} not found`
      );
    }

    // Query pending resident orders for this society
    const orders = await prisma.residentOrder.findMany({
      where: {
        societyId,
        status: ResidentOrderStatus.PENDING,
        ...(orderIds ? { id: { in: orderIds } } : {}),
      },
      include: {
        items: {
          include: { product: true },
        },
      },
      orderBy: { requestedAt: 'asc' },
    });

    if (orders.length === 0) {
      return { internalGroups: [], supplierFacingGroups: [] };
    }

    // Group items by productId
    const groupsMap = new Map<string, AggregatedDemandGroup>();

    for (const order of orders) {
      // Invariant check: verify society integrity on every order
      if (order.societyId !== societyId) {
        throw new ProcurementError(
          ProcurementErrorCode.SOCIETY_MISMATCH,
          `Order ${order.id} belongs to society ${order.societyId}, not ${societyId}`
        );
      }

      for (const item of order.items) {
        const key = `${item.productId}_${item.product.unit}`;
        let group = groupsMap.get(key);

        if (!group) {
          group = {
            societyId,
            productId: item.productId,
            productName: item.product.name,
            unit: item.product.unit,
            totalQuantity: item.quantity,
            contributingOrdersCount: 1,
            residentDemands: [
              {
                residentId: order.residentId,
                residentOrderId: order.id,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                totalPrice: item.totalPrice,
              },
            ],
          };
          groupsMap.set(key, group);
        } else {
          group.totalQuantity = addDecimals(group.totalQuantity, item.quantity);
          group.contributingOrdersCount += 1;
          group.residentDemands.push({
            residentId: order.residentId,
            residentOrderId: order.id,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalPrice: item.totalPrice,
          });
        }
      }
    }

    const internalGroups = Array.from(groupsMap.values());

    // Generate anonymous supplier-facing representation
    const supplierFacingGroups: SupplierFacingDemand[] = internalGroups.map((g) => ({
      societyId: g.societyId,
      productId: g.productId,
      productName: g.productName,
      unit: g.unit,
      totalQuantity: g.totalQuantity,
      contributingOrdersCount: g.contributingOrdersCount,
    }));

    // Record DEMAND_AGGREGATED operational audit event
    await prisma.auditEvent.create({
      data: {
        eventType: AuditEventType.DEMAND_AGGREGATED,
        actor: 'deterministic_core:aggregation_service',
        entityType: 'Society',
        entityId: societyId,
        metadata: {
          societyName: society.name,
          aggregatedBatchesCount: internalGroups.length,
          batches: supplierFacingGroups.map((b) => ({
            product: b.productName,
            totalQuantity: Number(b.totalQuantity),
            unit: b.unit,
            ordersCount: b.contributingOrdersCount,
          })),
        },
      },
    });

    return {
      internalGroups,
      supplierFacingGroups,
    };
  }
}

export const aggregationService = new AggregationService();

