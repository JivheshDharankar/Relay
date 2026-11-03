import { randomUUID } from 'crypto';
import { prisma } from '../../config/prisma';
import { DeliveryStatus, CommunityOrderStatus, AuditEventType } from '@prisma/client';
import { DeliveryStateSnapshot, DeliveryTransitionResult } from './types';

export class DeliverySimulatorError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'DeliverySimulatorError';
    this.code = code;
    this.details = details;
  }
}

const LEGAL_DELIVERY_SEQUENCE: DeliveryStatus[] = [
  DeliveryStatus.PENDING,
  DeliveryStatus.PREPARING,
  DeliveryStatus.DISPATCHED,
  DeliveryStatus.OUT_FOR_DELIVERY,
  DeliveryStatus.DELIVERED,
];

export class DeliverySimulator {
  /**
   * Initializes or retrieves a physical fulfillment record for a CommunityOrder.
   */
  public async initializeDelivery(
    communityOrderId: string,
    initialStatus: DeliveryStatus = DeliveryStatus.PREPARING
  ): Promise<DeliveryStateSnapshot> {
    const communityOrder = await prisma.communityOrder.findUnique({
      where: { id: communityOrderId },
    });

    if (!communityOrder) {
      throw new DeliverySimulatorError(
        'COMMUNITY_ORDER_NOT_FOUND',
        `Community order '${communityOrderId}' not found`
      );
    }

    const trackingCode = `TRK-SIM-${randomUUID().slice(0, 8).toUpperCase()}`;

    const delivery = await prisma.$transaction(async (tx) => {
      const existing = await tx.delivery.findUnique({
        where: { communityOrderId },
      });

      const del = await tx.delivery.upsert({
        where: { communityOrderId },
        update: {
          trackingCode: existing?.trackingCode ?? trackingCode,
        },
        create: {
          communityOrderId,
          status: initialStatus,
          trackingCode,
        },
      });

      await tx.auditEvent.create({
        data: {
          eventType: AuditEventType.DELIVERY_INITIALIZED,
          actor: 'simulator:delivery',
          entityType: 'Delivery',
          entityId: del.id,
          metadata: {
            communityOrderId,
            trackingCode,
            status: del.status,
          },
        },
      });

      return del;
    });

    return {
      deliveryId: delivery.id,
      communityOrderId: delivery.communityOrderId,
      status: delivery.status,
      trackingCode: delivery.trackingCode ?? undefined,
      dispatchedAt: delivery.dispatchedAt ?? undefined,
      deliveredAt: delivery.deliveredAt ?? undefined,
      updatedAt: delivery.updatedAt,
    };
  }

  /**
   * Deterministically advances the delivery state to the next state or specified target.
   */
  public async advanceDelivery(
    communityOrderId: string,
    targetStatus?: DeliveryStatus
  ): Promise<DeliveryTransitionResult> {
    const delivery = await prisma.delivery.findUnique({
      where: { communityOrderId },
    });

    if (!delivery) {
      throw new DeliverySimulatorError(
        'DELIVERY_NOT_FOUND',
        `No delivery record found for community order '${communityOrderId}'. Initialize delivery first.`
      );
    }

    const currentStatus = delivery.status;

    // Determine target status
    let nextStatus: DeliveryStatus;
    if (targetStatus) {
      nextStatus = targetStatus;
    } else {
      const currentIndex = LEGAL_DELIVERY_SEQUENCE.indexOf(currentStatus);
      if (currentIndex === -1 || currentIndex >= LEGAL_DELIVERY_SEQUENCE.length - 1) {
        return {
          success: true,
          deliveryId: delivery.id,
          communityOrderId,
          previousStatus: currentStatus,
          currentStatus,
          fromStatus: currentStatus,
          toStatus: currentStatus,
          isTerminal: currentStatus === DeliveryStatus.DELIVERED,
          message: `Delivery is already at terminal status '${currentStatus}'`,
          trackingCode: delivery.trackingCode ?? undefined,
          updatedAt: delivery.updatedAt,
        };
      }
      nextStatus = LEGAL_DELIVERY_SEQUENCE[currentIndex + 1];
    }

    if (currentStatus === nextStatus) {
      return {
        success: true,
        deliveryId: delivery.id,
        communityOrderId,
        previousStatus: currentStatus,
        currentStatus,
        fromStatus: currentStatus,
        toStatus: currentStatus,
        isTerminal: currentStatus === DeliveryStatus.DELIVERED,
        message: `Delivery is already at status '${currentStatus}'`,
        trackingCode: delivery.trackingCode ?? undefined,
        updatedAt: delivery.updatedAt,
      };
    }

    // State machine validation: Check legal progression
    this.validateTransition(currentStatus, nextStatus);

    const now = new Date();
    const isDispatched = nextStatus === DeliveryStatus.DISPATCHED;
    const isDelivered = nextStatus === DeliveryStatus.DELIVERED;

    const updated = await prisma.$transaction(async (tx) => {
      const del = await tx.delivery.update({
        where: { id: delivery.id },
        data: {
          status: nextStatus,
          trackingCode: delivery.trackingCode ?? `TRK-SIM-${randomUUID().slice(0, 8).toUpperCase()}`,
          dispatchedAt: isDispatched ? now : delivery.dispatchedAt,
          deliveredAt: isDelivered ? now : delivery.deliveredAt,
        },
      });

      // Synchronize CommunityOrder status if relevant
      if (isDispatched) {
        await tx.communityOrder.update({
          where: { id: communityOrderId },
          data: { status: CommunityOrderStatus.DISPATCHED },
        });
      } else if (isDelivered) {
        await tx.communityOrder.update({
          where: { id: communityOrderId },
          data: { status: CommunityOrderStatus.DELIVERED },
        });
      }

      // Record corresponding operational audit event
      const eventType = this.resolveAuditEvent(nextStatus);
      await tx.auditEvent.create({
        data: {
          eventType,
          actor: 'simulator:delivery',
          entityType: 'Delivery',
          entityId: del.id,
          metadata: {
            communityOrderId,
            previousStatus: currentStatus,
            currentStatus: nextStatus,
          },
        },
      });

      return del;
    });

    return {
      success: true,
      deliveryId: updated.id,
      communityOrderId,
      previousStatus: currentStatus,
      currentStatus: nextStatus,
      fromStatus: currentStatus,
      toStatus: nextStatus,
      trackingCode: updated.trackingCode ?? undefined,
      isTerminal: nextStatus === DeliveryStatus.DELIVERED,
      message: `Delivery successfully transitioned from '${currentStatus}' to '${nextStatus}'`,
      updatedAt: updated.updatedAt,
    };
  }

  /**
   * Retrieves live delivery simulator status.
   */
  public async getDeliveryStatus(communityOrderId: string): Promise<DeliveryStateSnapshot> {
    const delivery = await prisma.delivery.findUnique({
      where: { communityOrderId },
    });

    if (!delivery) {
      throw new DeliverySimulatorError(
        'DELIVERY_NOT_FOUND',
        `No delivery found for community order '${communityOrderId}'`
      );
    }

    return {
      deliveryId: delivery.id,
      communityOrderId: delivery.communityOrderId,
      status: delivery.status,
      trackingCode: delivery.trackingCode ?? undefined,
      dispatchedAt: delivery.dispatchedAt ?? undefined,
      deliveredAt: delivery.deliveredAt ?? undefined,
      updatedAt: delivery.updatedAt,
    };
  }

  private validateTransition(from: DeliveryStatus, to: DeliveryStatus): void {
    if (from === to) return;

    if (from === DeliveryStatus.DELIVERED) {
      throw new DeliverySimulatorError(
        'TERMINAL_STATE_LOCKED',
        `Cannot transition from terminal delivery state '${from}' to '${to}'`
      );
    }

    const fromIdx = LEGAL_DELIVERY_SEQUENCE.indexOf(from);
    const toIdx = LEGAL_DELIVERY_SEQUENCE.indexOf(to);

    if (fromIdx !== -1 && toIdx !== -1) {
      if (toIdx < fromIdx) {
        throw new DeliverySimulatorError(
          'INVALID_DELIVERY_TRANSITION',
          `Cannot transition delivery backwards from '${from}' to '${to}'`
        );
      }
      if (toIdx > fromIdx + 1) {
        throw new DeliverySimulatorError(
          'INVALID_DELIVERY_TRANSITION',
          `Cannot skip intermediate delivery states: attempted '${from}' to '${to}'`
        );
      }
    }
  }

  private resolveAuditEvent(status: DeliveryStatus): AuditEventType {
    switch (status) {
      case DeliveryStatus.PREPARING:
        return AuditEventType.DELIVERY_PREPARING;
      case DeliveryStatus.DISPATCHED:
        return AuditEventType.DISPATCHED;
      case DeliveryStatus.OUT_FOR_DELIVERY:
        return AuditEventType.DELIVERY_OUT_FOR_DELIVERY;
      case DeliveryStatus.DELIVERED:
        return AuditEventType.DELIVERED;
      case DeliveryStatus.PENDING:
      default:
        return AuditEventType.DELIVERY_INITIALIZED;
    }
  }
}

export const deliverySimulator = new DeliverySimulator();
