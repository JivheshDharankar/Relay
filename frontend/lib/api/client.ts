import { ApiErrorResponse } from '@/types';

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, status: number, code = 'API_ERROR', details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

export async function apiClient<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { timeoutMs = 8000, headers = {}, ...customOptions } = options;

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${API_BASE_URL}${cleanEndpoint}`;

  const token = typeof window !== 'undefined' ? localStorage.getItem('relay_session_token') : null;
  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  try {
    const response = await fetch(url, {
      ...customOptions,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...authHeaders,
        ...headers,
      },
      signal: controller.signal,
    });

    clearTimeout(id);

    if (response.status === 204) {
      return {} as T;
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const errorData = data as ApiErrorResponse | null;
      throw new ApiClientError(
        errorData?.error?.message || `Request failed with status ${response.status}`,
        response.status,
        errorData?.error?.code || 'HTTP_ERROR',
        // Some endpoints (e.g. procurement/reconcile → 422) return a useful
        // payload without an `error` envelope — preserve the whole body.
        errorData?.error?.details ?? (data as unknown)
      );
    }

    return data as T;
  } catch (err) {
    clearTimeout(id);

    if (err instanceof ApiClientError) {
      throw err;
    }

    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiClientError('Request timed out while contacting Relay backend', 408, 'TIMEOUT');
    }

    throw new ApiClientError(
      err instanceof Error ? err.message : 'Network communication error',
      0,
      'NETWORK_ERROR'
    );
  }
}
