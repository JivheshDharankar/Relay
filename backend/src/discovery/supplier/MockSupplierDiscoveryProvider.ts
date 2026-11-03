import { calculateDistanceKm } from '../../domain/procurement/geo';
import {
  SupplierDiscoveryProvider,
  SupplierDiscoveryError,
} from './SupplierDiscoveryProvider';
import { SupplierCandidate, SupplierDiscoveryQuery } from './types';

export interface MockSupplierDiscoveryConfig {
  candidates?: SupplierCandidate[];
  simulateFailure?: {
    code: 'MISSING_API_KEY' | 'REQUEST_TIMEOUT' | 'GEOAPIFY_AUTH_ERROR' | 'RATE_LIMIT_EXCEEDED' | 'GEOAPIFY_API_ERROR' | 'MALFORMED_RESPONSE';
    message: string;
    status?: number;
  };
}

/**
 * Fallback & testing implementation of SupplierDiscoveryProvider.
 * Generates deterministic supplier candidates around any valid coordinates.
 */
export class MockSupplierDiscoveryProvider implements SupplierDiscoveryProvider {
  public readonly providerName = 'mock';
  private config: MockSupplierDiscoveryConfig;

  constructor(config?: MockSupplierDiscoveryConfig) {
    this.config = config ?? {};
  }

  public setCandidates(candidates: SupplierCandidate[]): void {
    this.config.candidates = candidates;
  }

  public setSimulatedFailure(failure?: MockSupplierDiscoveryConfig['simulateFailure']): void {
    this.config.simulateFailure = failure;
  }

  public reset(): void {
    this.config = {};
  }

  public async discoverSuppliers(
    query: SupplierDiscoveryQuery
  ): Promise<SupplierCandidate[]> {
    // 1. Check for simulated operational failure
    if (this.config.simulateFailure) {
      throw new SupplierDiscoveryError(
        this.config.simulateFailure.code,
        this.config.simulateFailure.message,
        this.config.simulateFailure.status
      );
    }

    // 2. Validate Runtime Coordinates
    const { latitude, longitude } = query.coordinates || {};
    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      Number.isNaN(latitude) ||
      Number.isNaN(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new SupplierDiscoveryError(
        'INVALID_COORDINATES',
        `Invalid geographic coordinates: latitude must be [-90, 90] and longitude [-180, 180]. Received lat=${latitude}, lon=${longitude}`
      );
    }

    // 3. Validate Radius
    const radiusMeters = query.radiusMeters ?? 5000;
    if (
      typeof radiusMeters !== 'number' ||
      Number.isNaN(radiusMeters) ||
      radiusMeters <= 0
    ) {
      throw new SupplierDiscoveryError(
        'INVALID_RADIUS',
        `Invalid search radius: must be a positive number in meters. Received ${radiusMeters}`
      );
    }

    // 4. Validate Limit
    const limit = query.limit ?? 20;
    if (
      typeof limit !== 'number' ||
      Number.isNaN(limit) ||
      limit < 1 ||
      !Number.isInteger(limit)
    ) {
      throw new SupplierDiscoveryError(
        'INVALID_LIMIT',
        `Invalid result limit: must be a positive integer. Received ${limit}`
      );
    }

    // 5. If custom mock candidates provided, recalculate distances and return
    if (this.config.candidates) {
      return this.config.candidates.slice(0, limit).map((c) => {
        const distanceKm = calculateDistanceKm(
          { latitude, longitude },
          { latitude: c.latitude, longitude: c.longitude }
        );
        return {
          ...c,
          distanceKm,
          distanceMeters: Math.round(distanceKm * 1000),
        };
      });
    }

    // 6. Generate deterministic candidates around the query coordinates
    // Offsets (~0.01 degree is approx 1.1 km)
    const offsets = [
      { dLat: 0.008, dLon: 0.006, name: 'Local Agro Wholesale Direct' },
      { dLat: -0.012, dLon: 0.009, name: 'Community Grain & Oil Depot' },
      { dLat: 0.015, dLon: -0.011, name: 'Metro Bulk Food Wholesalers' },
    ];

    const results: SupplierCandidate[] = [];

    for (let i = 0; i < Math.min(offsets.length, limit); i++) {
      const off = offsets[i];
      const supLat = latitude + off.dLat;
      const supLon = longitude + off.dLon;

      const distanceKm = calculateDistanceKm(
        { latitude, longitude },
        { latitude: supLat, longitude: supLon }
      );
      const distanceMeters = Math.round(distanceKm * 1000);

      // Only include if within search radius
      if (distanceMeters <= radiusMeters) {
        results.push({
          id: `mock_sup_${i + 1}`,
          name: off.name,
          formattedAddress: `Plot ${100 + i * 25}, Industrial Area (${supLat.toFixed(4)}, ${supLon.toFixed(4)})`,
          latitude: supLat,
          longitude: supLon,
          distanceKm,
          distanceMeters,
          categories: ['commercial.wholesale', 'commercial.food_and_drink'],
          source: 'mock',
          phone: `+91 98000 ${10000 + i * 1111}`,
          email: `orders@mocksupplier${i + 1}.example.com`,
          website: `https://mocksupplier${i + 1}.example.com`,
        });
      }
    }

    return results;
  }
}

export const mockSupplierDiscoveryProvider = new MockSupplierDiscoveryProvider();

