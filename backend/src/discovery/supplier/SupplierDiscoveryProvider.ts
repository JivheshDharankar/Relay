import { SupplierCandidate, SupplierDiscoveryQuery } from './types';

export type SupplierDiscoveryErrorCode =
  | 'MISSING_API_KEY'
  | 'INVALID_COORDINATES'
  | 'INVALID_RADIUS'
  | 'INVALID_LIMIT'
  | 'REQUEST_TIMEOUT'
  | 'GEOAPIFY_AUTH_ERROR'
  | 'RATE_LIMIT_EXCEEDED'
  | 'GEOAPIFY_API_ERROR'
  | 'MALFORMED_RESPONSE';

/**
 * Standardized error thrown when supplier discovery encounters an operational failure.
 * Ensures failures are explicit rather than silently fabricating mock results.
 */
export class SupplierDiscoveryError extends Error {
  public readonly code: SupplierDiscoveryErrorCode;
  public readonly status?: number;
  public readonly details?: unknown;

  constructor(
    code: SupplierDiscoveryErrorCode,
    message: string,
    status?: number,
    details?: unknown
  ) {
    super(message);
    this.name = 'SupplierDiscoveryError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Common abstraction for discovering potential physical suppliers near a community location.
 * Completely independent of procurement ranking, ordering, billing, or negotiation.
 */
export interface SupplierDiscoveryProvider {
  readonly providerName: string;

  /**
   * Discovers supplier candidates within a geographic radius around runtime coordinates.
   *
   * @param query Geographic criteria (latitude, longitude, radius, optional keywords/categories, limit)
   * @returns Normalized array of SupplierCandidate objects (empty array if none found; never mock data on real failure)
   */
  discoverSuppliers(query: SupplierDiscoveryQuery): Promise<SupplierCandidate[]>;
}

