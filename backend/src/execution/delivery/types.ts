import { DeliveryStatus } from '@prisma/client';

export interface DeliveryStateSnapshot {
  deliveryId: string;
  communityOrderId: string;
  status: DeliveryStatus;
  trackingCode?: string;
  dispatchedAt?: Date;
  deliveredAt?: Date;
  updatedAt: Date;
}

export interface DeliveryTransitionResult {
  success: boolean;
  deliveryId: string;
  communityOrderId: string;
  previousStatus: DeliveryStatus;
  currentStatus: DeliveryStatus;
  fromStatus: DeliveryStatus;
  toStatus: DeliveryStatus;
  isTerminal: boolean;
  message: string;
  trackingCode?: string;
  updatedAt?: Date;
}
