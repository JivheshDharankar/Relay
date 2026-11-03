import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GeoapifySupplierProvider,
  MockSupplierDiscoveryProvider,
  SupplierDiscoveryError,
  getSupplierDiscoveryProvider,
} from '../src/discovery/supplier';

// Synthetic dummy key strictly for mock client instantiation in tests (never calls real API)
const TEST_API_KEY = 'synthetic_test_key_for_unit_tests_only';
const TEST_BASE_URL = 'https://api.geoapify.test';

function createMockResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe('Milestone 10 Phase 1 — Geoapify Supplier Discovery Infrastructure', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Location-Agnostic Geographic Searches', () => {
    it('discovers and normalizes candidates around Pune coordinates from mocked response', async () => {
      let requestedUrl = '';
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        requestedUrl = url;
        return createMockResponse({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {
                place_id: 'pune_place_123',
                name: 'Sahyadri Agro Wholesale Mart',
                country: 'India',
                state: 'Maharashtra',
                city: 'Pune',
                postcode: '411004',
                street: 'Shivaji Road',
                formatted: 'Sahyadri Agro Wholesale Mart, Shivaji Road, Pune, Maharashtra 411004',
                lat: 18.525,
                lon: 73.86,
                distance: 650,
                categories: ['commercial.wholesale', 'commercial.food_and_drink'],
                contact: { phone: '+91 20 25551234' },
                website: 'https://sahyadri-agro.example.com',
              },
              geometry: {
                type: 'Point',
                coordinates: [73.86, 18.525],
              },
            },
          ],
        });
      });

      const provider = new GeoapifySupplierProvider({
        apiKey: TEST_API_KEY,
        baseUrl: TEST_BASE_URL,
        fetchFn: mockFetch,
      });

      const candidates = await provider.discoverSuppliers({
        coordinates: { latitude: 18.5204, longitude: 73.8567 },
        radiusMeters: 5000,
      });

      expect(candidates).toHaveLength(1);
      const [cand] = candidates;
      expect(cand.id).toBe('geoapify_pune_place_123');
      expect(cand.name).toBe('Sahyadri Agro Wholesale Mart');
      expect(cand.latitude).toBe(18.525);
      expect(cand.longitude).toBe(73.86);
      expect(cand.distanceMeters).toBe(650);
      expect(cand.distanceKm).toBe(0.65);
      expect(cand.source).toBe('geoapify');
      expect(cand.categories).toContain('commercial.wholesale');
      expect(cand.phone).toBe('+91 20 25551234');
      expect(cand.website).toBe('https://sahyadri-agro.example.com');

      // Verify Geoapify circle filter has circle:lon,lat,radius (GeoJSON lon-first order)
      const parsedUrl = new URL(requestedUrl);
      expect(parsedUrl.searchParams.get('filter')).toBe('circle:73.8567,18.5204,5000');
      expect(parsedUrl.searchParams.get('bias')).toBe('proximity:73.8567,18.5204');
    });

    it('executes Bangalore coordinates through the exact same code path without city hardcoding', async () => {
      let requestedUrl = '';
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        requestedUrl = url;
        return createMockResponse({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {
                place_id: 'blr_place_456',
                name: 'Koramangala Grain Direct',
                city: 'Bengaluru',
                formatted: 'Koramangala Grain Direct, 80 Feet Road, Bengaluru',
                lat: 12.935,
                lon: 77.62,
                distance: 1200,
                categories: ['commercial.supermarket'],
              },
              geometry: {
                type: 'Point',
                coordinates: [77.62, 12.935],
              },
            },
          ],
        });
      });

      const provider = new GeoapifySupplierProvider({
        apiKey: TEST_API_KEY,
        baseUrl: TEST_BASE_URL,
        fetchFn: mockFetch,
      });

      const candidates = await provider.discoverSuppliers({
        coordinates: { latitude: 12.9716, longitude: 77.5946 },
        radiusMeters: 8000,
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].name).toBe('Koramangala Grain Direct');
      expect(candidates[0].latitude).toBe(12.935);
      expect(candidates[0].longitude).toBe(77.62);

      const parsedUrl = new URL(requestedUrl);
      expect(parsedUrl.searchParams.get('filter')).toBe('circle:77.5946,12.9716,8000');
      expect(parsedUrl.searchParams.get('bias')).toBe('proximity:77.5946,12.9716');
    });

    it('works symmetrically with arbitrary global coordinates (e.g. London, Tokyo) with zero location branching', async () => {
      const locations = [
        { lat: 51.5074, lon: -0.1278, label: 'London' },
        { lat: 35.6762, lon: 139.6503, label: 'Tokyo' },
        { lat: 28.6139, lon: 77.209, label: 'Delhi' },
      ];

      for (const loc of locations) {
        let capturedFilter = '';
        const mockFetch = vi.fn().mockImplementation(async (url: string) => {
          const u = new URL(url);
          capturedFilter = u.searchParams.get('filter') || '';
          return createMockResponse({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {
                  place_id: `place_${loc.label}`,
                  name: `Supplier in ${loc.label}`,
                  formatted: `Address in ${loc.label}`,
                  lat: loc.lat + 0.001,
                  lon: loc.lon + 0.001,
                },
                geometry: {
                  type: 'Point',
                  coordinates: [loc.lon + 0.001, loc.lat + 0.001],
                },
              },
            ],
          });
        });

        const provider = new GeoapifySupplierProvider({
          apiKey: TEST_API_KEY,
          baseUrl: TEST_BASE_URL,
          fetchFn: mockFetch,
        });

        const candidates = await provider.discoverSuppliers({
          coordinates: { latitude: loc.lat, longitude: loc.lon },
          radiusMeters: 3000,
        });

        expect(candidates).toHaveLength(1);
        expect(candidates[0].name).toBe(`Supplier in ${loc.label}`);
        expect(capturedFilter).toBe(`circle:${loc.lon},${loc.lat},3000`);
      }
    });
  });

  describe('2. Query Parameter Construction', () => {
    it('passes search radius, limit, search term, and categories correctly to Geoapify Places API', async () => {
      let requestedUrl = '';
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        requestedUrl = url;
        return createMockResponse({
          type: 'FeatureCollection',
          features: [],
        });
      });

      const provider = new GeoapifySupplierProvider({
        apiKey: TEST_API_KEY,
        baseUrl: TEST_BASE_URL,
        fetchFn: mockFetch,
      });

      await provider.discoverSuppliers({
        coordinates: { latitude: 19.076, longitude: 72.8777 },
        radiusMeters: 12500,
        limit: 15,
        searchTerm: 'wholesale pulses',
        categories: ['commercial.supermarket', 'commercial.marketplace'],
      });

      const parsedUrl = new URL(requestedUrl);
      expect(parsedUrl.pathname).toBe('/v2/places');
      expect(parsedUrl.searchParams.get('filter')).toBe('circle:72.8777,19.076,12500');
      expect(parsedUrl.searchParams.get('limit')).toBe('15');
      expect(parsedUrl.searchParams.get('name')).toBe('wholesale pulses');
      expect(parsedUrl.searchParams.get('categories')).toBe('commercial.supermarket,commercial.marketplace');
      expect(parsedUrl.searchParams.get('apiKey')).toBe(TEST_API_KEY);
    });
  });

  describe('3. Robust Error Handling', () => {
    it('throws MISSING_API_KEY when instantiated without an API key', async () => {
      const provider = new GeoapifySupplierProvider({
        apiKey: '',
        fetchFn: vi.fn(),
      });

      await expect(
        provider.discoverSuppliers({
          coordinates: { latitude: 18.5204, longitude: 73.8567 },
        })
      ).rejects.toMatchObject({
        name: 'SupplierDiscoveryError',
        code: 'MISSING_API_KEY',
      });
    });

    it('rejects invalid coordinates with INVALID_COORDINATES', async () => {
      const provider = new GeoapifySupplierProvider({
        apiKey: TEST_API_KEY,
        fetchFn: vi.fn(),
      });

      // Latitude > 90
      await expect(
        provider.discoverSuppliers({
          coordinates: { latitude: 95.0, longitude: 73.8567 },
        })
      ).rejects.toMatchObject({ code: 'INVALID_COORDINATES' });

      // Latitude < -90
      await expect(
        provider.discoverSuppliers({
          coordinates: { latitude: -95.0, longitude: 73.8567 },
        })
      ).rejects.toMatchObject({ code: 'INVALID_COORDINATES' });

      // Longitude > 180
      await expect(
        provider.discoverSuppliers({
          coordinates: { latitude: 18.5204, longitude: 190.0 },
        })
      ).rejects.toMatchObject({ code: 'INVALID_COORDINATES' });

      // NaN
      await expect(
        provider.discoverSuppliers({
          coordinates: { latitude: NaN, longitude: 73.8567 },
        })
      ).rejects.toMatchObject({ code: 'INVALID_COORDINATES' });
    });

    it('rejects invalid radius with INVALID_RADIUS', async () => {
      const provider = new GeoapifySupplierProvider({
        apiKey: TEST_API_KEY,
        fetchFn: vi.fn(),
      });

      await expect(
        provider.discoverSuppliers({
          coordinates: { latitude: 18.5204, longitude: 73.8567 },
          radiusMeters: -500,
        })
      ).rejects.toMatchObject({ code: 'INVALID_RADIUS' });

      await expect(
        provider.discoverSuppliers({
          coordinates: { latitude: 18.5204, longitude: 73.8567 },
          radiusMeters: 0,
        })
      ).rejects.toMatchObject({ code: 'INVALID_RADIUS' });
    });

    it('rejects invalid limit with INVALID_LIMIT', async () => {
      const provider = new GeoapifySupplierProvider({
        apiKey: TEST_API_KEY,
        fetchFn: vi.fn(),
      });

      await expect(
        provider.discoverSuppliers({
          coordinates: { latitude: 18.5204, longitude: 73.8567 },
          limit: 0,
        })
      ).rejects.toMatchObject({ code: 'INVALID_LIMIT' });

      await expect(
        provider.discoverSuppliers({
          coordinates: { latitude: 18.5204, longitude: 73.8567 },
          limit: 3.5,
        })
      ).rejects.toMatchObject({ code: 'INVALID_LIMIT' });
    });

    it('handles request timeouts with REQUEST_TIMEOUT', async () => {
      const mockFetch = vi.fn().mockImplementation(async (_url: string, opts: { signal?: AbortSignal }) => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      });

      const provider = new GeoapifySupplierProvider({
        apiKey: TEST_API_KEY,
        fetchFn: mockFetch,
        timeoutMs: 50,
      });

      await expect(
        provider.discoverSuppliers({
          coordinates: { latitude: 18.5204, longitude: 73.8567 },
        })
      ).rejects.toMatchObject({
        name: 'SupplierDiscoveryError',
        code: 'REQUEST_TIMEOUT',
      });
    });

    it('handles Geoapify 401/403 authentication failures with GEOAPIFY_AUTH_ERROR', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        return createMockResponse({ message: 'Invalid API key' }, 401, 'Unauthorized');
      });

      const provider = new GeoapifySupplierProvider({
        apiKey: TEST_API_KEY,
        fetchFn: mockFetch,
      });

      await expect(
        provider.discoverSuppliers({
          coordinates: { latitude: 18.5204, longitude: 73.8567 },
        })
      ).rejects.toMatchObject({
        name: 'SupplierDiscoveryError',
        code: 'GEOAPIFY_AUTH_ERROR',
        status: 401,
      });
    });

    it('handles Geoapify 429 rate limit errors with RATE_LIMIT_EXCEEDED', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        return createMockResponse({ message: 'Rate limit exceeded' }, 429, 'Too Many Requests');
      });

      const provider = new GeoapifySupplierProvider({
        apiKey: TEST_API_KEY,
        fetchFn: mockFetch,
      });

      await expect(
        provider.discoverSuppliers({
          coordinates: { latitude: 18.5204, longitude: 73.8567 },
        })
      ).rejects.toMatchObject({
        name: 'SupplierDiscoveryError',
        code: 'RATE_LIMIT_EXCEEDED',
        status: 429,
      });
    });

    it('handles Geoapify 500 server errors with GEOAPIFY_API_ERROR', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        return createMockResponse({ message: 'Internal Server Error' }, 500, 'Internal Server Error');
      });

      const provider = new GeoapifySupplierProvider({
        apiKey: TEST_API_KEY,
        fetchFn: mockFetch,
      });

      await expect(
        provider.discoverSuppliers({
          coordinates: { latitude: 18.5204, longitude: 73.8567 },
        })
      ).rejects.toMatchObject({
        name: 'SupplierDiscoveryError',
        code: 'GEOAPIFY_API_ERROR',
        status: 500,
      });
    });

    it('handles malformed Geoapify response structures safely with MALFORMED_RESPONSE', async () => {
      // Not a FeatureCollection
      const mockFetchNotGeoJson = vi.fn().mockImplementation(async () => {
        return createMockResponse({ notAFeatureCollection: true });
      });

      const provider1 = new GeoapifySupplierProvider({
        apiKey: TEST_API_KEY,
        fetchFn: mockFetchNotGeoJson,
      });

      await expect(
        provider1.discoverSuppliers({
          coordinates: { latitude: 18.5204, longitude: 73.8567 },
        })
      ).rejects.toMatchObject({
        name: 'SupplierDiscoveryError',
        code: 'MALFORMED_RESPONSE',
      });

      // Features not an array
      const mockFetchBadFeatures = vi.fn().mockImplementation(async () => {
        return createMockResponse({ type: 'FeatureCollection', features: 'not_an_array' });
      });

      const provider2 = new GeoapifySupplierProvider({
        apiKey: TEST_API_KEY,
        fetchFn: mockFetchBadFeatures,
      });

      await expect(
        provider2.discoverSuppliers({
          coordinates: { latitude: 18.5204, longitude: 73.8567 },
        })
      ).rejects.toMatchObject({
        name: 'SupplierDiscoveryError',
        code: 'MALFORMED_RESPONSE',
      });
    });

    it('zero-result search returns an empty candidate list rather than fake or fallback data', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        return createMockResponse({
          type: 'FeatureCollection',
          features: [],
        });
      });

      const provider = new GeoapifySupplierProvider({
        apiKey: TEST_API_KEY,
        fetchFn: mockFetch,
      });

      const candidates = await provider.discoverSuppliers({
        coordinates: { latitude: 18.5204, longitude: 73.8567 },
        radiusMeters: 5000,
      });

      // Must return empty array, NOT silent mock data
      expect(candidates).toEqual([]);
    });
  });

  describe('4. MockSupplierDiscoveryProvider & Deterministic Selection', () => {
    it('MockSupplierDiscoveryProvider discovers candidates around arbitrary coordinates', async () => {
      const mockProvider = new MockSupplierDiscoveryProvider();

      const candidates = await mockProvider.discoverSuppliers({
        coordinates: { latitude: 19.076, longitude: 72.8777 },
        radiusMeters: 10000,
      });

      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].source).toBe('mock');
      expect(candidates[0].distanceMeters).toBeGreaterThan(0);
      expect(candidates[0].distanceMeters).toBeLessThanOrEqual(10000);
    });

    it('MockSupplierDiscoveryProvider enforces coordinate and radius validation', async () => {
      const mockProvider = new MockSupplierDiscoveryProvider();

      await expect(
        mockProvider.discoverSuppliers({
          coordinates: { latitude: 150, longitude: 72.8777 },
        })
      ).rejects.toMatchObject({ code: 'INVALID_COORDINATES' });

      await expect(
        mockProvider.discoverSuppliers({
          coordinates: { latitude: 19.076, longitude: 72.8777 },
          radiusMeters: -100,
        })
      ).rejects.toMatchObject({ code: 'INVALID_RADIUS' });
    });

    it('getSupplierDiscoveryProvider deterministically selects geoapify or mock', () => {
      const geoProvider = getSupplierDiscoveryProvider('geoapify');
      expect(geoProvider.providerName).toBe('geoapify');

      const mockProvider = getSupplierDiscoveryProvider('mock');
      expect(mockProvider.providerName).toBe('mock');
    });
  });
});

