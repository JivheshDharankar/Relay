import { apiClient } from './client';

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export interface SocietyRecord {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  postalCode?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  verificationStatus?: string;
  verified?: boolean;
}

export interface SocietySearchParams {
  query?: string;
  city?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  limit?: number;
}

export interface SocietyRegistration {
  name: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  latitude: number;
  longitude: number;
}

export async function searchSocieties(params: SocietySearchParams): Promise<SocietyRecord[]> {
  const search = new URLSearchParams();
  if (params.query) search.set('q', params.query);
  if (params.city) search.set('city', params.city);
  if (params.postalCode) search.set('postalCode', params.postalCode);
  if (params.latitude !== undefined) search.set('lat', String(params.latitude));
  if (params.longitude !== undefined) search.set('lng', String(params.longitude));
  if (params.radiusKm !== undefined) search.set('radius', String(params.radiusKm));
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  const res = await apiClient<ApiResponse<SocietyRecord[]>>(
    `/api/societies/search?${search.toString()}`
  );
  return res.data;
}

export async function registerSociety(input: SocietyRegistration): Promise<SocietyRecord> {
  const res = await apiClient<ApiResponse<SocietyRecord>>('/api/societies/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return res.data;
}

export async function getSocietyById(id: string): Promise<SocietyRecord> {
  const res = await apiClient<ApiResponse<SocietyRecord>>(
    `/api/societies/${encodeURIComponent(id)}`
  );
  return res.data;
}

export async function getSupplierDeliveryView(id: string): Promise<Record<string, unknown>> {
  const res = await apiClient<ApiResponse<Record<string, unknown>>>(
    `/api/societies/${encodeURIComponent(id)}/supplier-delivery-view`
  );
  return res.data;
}
