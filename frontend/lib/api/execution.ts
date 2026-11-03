import { apiClient, ApiClientError } from './client';
import { DeliverySnapshot, ReconciliationReport } from '@/types';
import type { FullCycleResult } from '@/lib/workflow/types';

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export async function getDeliveryStatus(communityOrderId: string): Promise<DeliverySnapshot> {
  const res = await apiClient<ApiResponse<DeliverySnapshot>>(
    `/api/execution/delivery/${encodeURIComponent(communityOrderId)}`
  );
  return res.data;
}

export async function executeFullCycle(
  communityOrderId: string,
  allocations?: { residentOrderId: string; productId: string; quantity: number | string }[]
): Promise<FullCycleResult> {
  const res = await apiClient<ApiResponse<FullCycleResult>>('/api/execution/full-cycle', {
    method: 'POST',
    body: JSON.stringify({ communityOrderId, allocations }),
    timeoutMs: 60000,
  });
  return res.data;
}

export async function reconcileCommunityOrder(
  communityOrderId: string
): Promise<ReconciliationReport> {
  try {
    const res = await apiClient<ApiResponse<ReconciliationReport>>('/api/procurement/reconcile', {
      method: 'POST',
      body: JSON.stringify({ communityOrderId }),
      timeoutMs: 30000,
    });
    return res.data;
  } catch (err) {
    // 422 carries the failed report in the response body — still evidence.
    if (err instanceof ApiClientError && err.status === 422) {
      const body = err.details as { data?: ReconciliationReport } | undefined;
      if (body?.data && typeof body.data === 'object' && 'communityOrderId' in body.data) {
        return body.data;
      }
    }
    throw err;
  }
}
