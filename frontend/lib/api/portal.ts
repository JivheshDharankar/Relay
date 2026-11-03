import { apiClient } from './client';
import {
  ResidentProfile,
  PortalOrder,
  CommunityData,
  MandateLimitUpdate,
  PaymentSummary,
  VerifiedSupplier,
} from '@/types';

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export async function getResidentProfile(): Promise<ResidentProfile> {
  const res = await apiClient<ApiResponse<ResidentProfile>>('/api/portal/resident');
  return res.data;
}

export async function getOrders(): Promise<PortalOrder[]> {
  const res = await apiClient<ApiResponse<PortalOrder[]>>('/api/portal/orders');
  return res.data;
}

export async function getCommunity(): Promise<CommunityData> {
  const res = await apiClient<ApiResponse<CommunityData>>('/api/portal/community');
  return res.data;
}

export async function getPayments(): Promise<PaymentSummary> {
  const res = await apiClient<ApiResponse<PaymentSummary>>('/api/portal/payments');
  return res.data;
}

export async function getSuppliers(): Promise<VerifiedSupplier[]> {
  const res = await apiClient<ApiResponse<VerifiedSupplier[]>>('/api/portal/suppliers');
  return res.data;
}

export async function updateMandateLimit(spendingLimit: number): Promise<MandateLimitUpdate> {
  const res = await apiClient<ApiResponse<MandateLimitUpdate>>('/api/portal/mandate', {
    method: 'PATCH',
    body: JSON.stringify({ spendingLimit }),
  });
  return res.data;
}
