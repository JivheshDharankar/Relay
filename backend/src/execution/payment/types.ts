import { PaymentStatus, Prisma } from '@prisma/client';

export interface PaymentExecutionRequest {
  residentOrderId: string;
  paymentMandateId: string;
  amount: Prisma.Decimal | number;
  currency?: string;
  idempotencyKey?: string;
  purpose?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentExecutionResponse {
  success: boolean;
  paymentId: string;
  providerReference: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  failureCode?: string;
  failureReason?: string;
  executedAt: Date;
  isDuplicate?: boolean;
}

export interface RefundRequest {
  paymentId: string;
  amount?: number;
  reason?: string;
}

export interface RefundResponse {
  success: boolean;
  refundReference: string;
  amount: number;
  status: PaymentStatus;
}

