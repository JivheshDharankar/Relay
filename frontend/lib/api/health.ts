import { apiClient } from './client';
import { SystemHealth } from '@/types';

export async function getHealth(): Promise<SystemHealth> {
  return apiClient<SystemHealth>('/health', {
    cache: 'no-store',
  });
}
