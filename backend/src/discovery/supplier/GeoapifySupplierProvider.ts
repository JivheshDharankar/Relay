import { env } from '../../config/env';
import { calculateDistanceKm } from '../../domain/procurement/geo';
import {
  SupplierDiscoveryProvider,
  SupplierDiscoveryError,
} from './SupplierDiscoveryProvider';
import {
  GeoapifyProviderConfig,
  SupplierCandidate,
  SupplierDiscoveryQuery,
} from './types';

/**
 * Default categories targeting commercial food, wholesale, and grocery suppliers.
 * Can be overridden at runtime via query.categories.
 */
const DEFAULT_COMMERCIAL_CATEGORIES = [
  'commercial.supermarket',
  'commercial.food_and_drink',
  'commercial.marketplace',
  'commercial.convenience',
];

/**
 * Geoapify Places categories verified valid against the live API.
 * Relay's token-based discovery vocabulary is broader (wholesale, kirana,
 * dealer, ...); anything outside this set is dropped before the request so
 * a 400 from one unknown category can never fail the whole discovery call.
 */
const GEOAPIFY_VALID_CATEGORIES = new Set([
  'commercial.supermarket',
  'commercial.food_and_drink',
  'commercial.marketplace',
  'commercial.convenience',
  'commercial.department_store',
  'commercial.chemist',
  'commercial.discount_store',
]);

interface GeoapifyRawFeature {
  type: string;
  properties?: {
    place_id?: string;
    name?: string;
    country?: string;
    country_code?: string;
    state?: string;
    city?: string;
    postcode?: string;
    street?: string;
    housenumber?: string;
    lon?: number;
    lat?: number;
    formatted?: string;
    address_line1?: string;
    address_line2?: string;
    categories?: string[];
    distance?: number;
    contact?: {
      phone?: string;
      email?: string;
    };
    website?: string;
  };
  geometry?: {
    type: string;
    coordinates?: [number, number]; // [lon, lat]
  };
}

interface GeoapifyPlacesResponse {
  type: string;
  features: GeoapifyRawFeature[];
}

/**
 * Production implementation of SupplierDiscoveryProvider backed by Geoapify Places API v2.
 * Strictly location-agnostic: operates on canonical latitude/longitude coordinates anywhere on Earth.
 */
export class GeoapifySupplierProvider implements SupplierDiscoveryProvider {
  public readonly providerName = 'geoapify';
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config?: GeoapifyProviderConfig) {
    this.apiKey = config?.apiKey ?? env.GEOAPIFY_API_KEY;
    this.baseUrl = (config?.baseUrl ?? env.GEOAPIFY_BASE_URL ?? 'https://api.geoapify.com').replace(/\/$/, '');
    this.timeoutMs = config?.timeoutMs ?? 10000;
    this.fetchFn = config?.fetchFn ?? globalThis.fetch;
  }

  /**
   * Discovers local commercial supplier candidates within radiusMeters of the provided coordinates.
   */
  public async discoverSuppliers(
    query: SupplierDiscoveryQuery
  ): Promise<SupplierCandidate[]> {
    // 1. Validate API Key
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new SupplierDiscoveryError(
        'MISSING_API_KEY',
        'Geoapify API key is required but not configured. Set GEOAPIFY_API_KEY in the environment.'
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

    // 5. Construct Geoapify Places API v2 URL
    // Format: /v2/places?categories=...&filter=circle:lon,lat,radiusMeters&bias=proximity:lon,lat&limit=...
    const requested =
      query.categories && query.categories.length > 0
        ? query.categories
        : DEFAULT_COMMERCIAL_CATEGORIES;
    const categories = requested.filter((c) => GEOAPIFY_VALID_CATEGORIES.has(c));
    const effectiveCategories =
      categories.length > 0 ? categories : DEFAULT_COMMERCIAL_CATEGORIES;

    const url = new URL(`${this.baseUrl}/v2/places`);
    url.searchParams.set('categories', effectiveCategories.join(','));
    // Note: Geoapify circle filter uses circle:lon,lat,radius
    url.searchParams.set('filter', `circle:${longitude},${latitude},${radiusMeters}`);
    url.searchParams.set('bias', `proximity:${longitude},${latitude}`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('apiKey', this.apiKey);

    if (query.searchTerm && query.searchTerm.trim().length > 0) {
      url.searchParams.set('name', query.searchTerm.trim());
    }

    // 6. Execute HTTP Request with strict timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (
        (err instanceof Error && err.name === 'AbortError') ||
        controller.signal.aborted
      ) {
        throw new SupplierDiscoveryError(
          'REQUEST_TIMEOUT',
          `Geoapify API request timed out after ${this.timeoutMs}ms`
        );
      }
      throw new SupplierDiscoveryError(
        'GEOAPIFY_API_ERROR',
        `Network error communicating with Geoapify: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        err
      );
    } finally {
      clearTimeout(timer);
    }

    // 7. Handle HTTP Error Statuses
    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text().catch(() => null);
      }

      if (response.status === 401 || response.status === 403) {
        throw new SupplierDiscoveryError(
          'GEOAPIFY_AUTH_ERROR',
          `Geoapify authentication failed (HTTP ${response.status}). Verify GEOAPIFY_API_KEY.`,
          response.status,
          errorBody
        );
      }

      if (response.status === 429) {
        throw new SupplierDiscoveryError(
          'RATE_LIMIT_EXCEEDED',
          'Geoapify API rate limit exceeded (HTTP 429). Please retry after backoff.',
          429,
          errorBody
        );
      }

      throw new SupplierDiscoveryError(
        'GEOAPIFY_API_ERROR',
        `Geoapify Places API returned HTTP ${response.status}: ${response.statusText}`,
        response.status,
        errorBody
      );
    }

    // 8. Parse and Validate Response JSON
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new SupplierDiscoveryError(
        'MALFORMED_RESPONSE',
        'Geoapify returned invalid or unparseable JSON',
        response.status,
        err
      );
    }

    const data = parsed as GeoapifyPlacesResponse;
    if (
      !data ||
      typeof data !== 'object' ||
      data.type !== 'FeatureCollection' ||
      !Array.isArray(data.features)
    ) {
      throw new SupplierDiscoveryError(
        'MALFORMED_RESPONSE',
        'Geoapify response does not conform to GeoJSON FeatureCollection structure',
        response.status,
        parsed
      );
    }

    // Zero results returns clean empty list
    if (data.features.length === 0) {
      return [];
    }

    // 9. Normalize Features to SupplierCandidate[]
    const candidates: SupplierCandidate[] = [];

    for (const feature of data.features) {
      if (!feature || typeof feature !== 'object') continue;

      const props = feature.properties || {};

      // Resolve coordinates from properties or geometry coordinates [lon, lat]
      const placeLat =
        typeof props.lat === 'number'
          ? props.lat
          : feature.geometry?.coordinates?.[1];
      const placeLon =
        typeof props.lon === 'number'
          ? props.lon
          : feature.geometry?.coordinates?.[0];

      if (
        typeof placeLat !== 'number' ||
        typeof placeLon !== 'number' ||
        Number.isNaN(placeLat) ||
        Number.isNaN(placeLon)
      ) {
        // Skip feature without valid coordinates
        continue;
      }

      const id = props.place_id
        ? `geoapify_${props.place_id}`
        : `geoapify_${placeLat.toFixed(6)}_${placeLon.toFixed(6)}`;

      const name =
        props.name ||
        props.address_line1 ||
        props.formatted ||
        'Local Commercial Supplier';

      const formattedAddress =
        props.formatted ||
        [props.address_line1, props.address_line2].filter(Boolean).join(', ') ||
        `${placeLat}, ${placeLon}`;

      // Calculate distance from query origin
      let distanceKm: number;
      let distanceMeters: number;

      if (typeof props.distance === 'number' && !Number.isNaN(props.distance)) {
        distanceMeters = Math.round(props.distance);
        distanceKm = Math.round((distanceMeters / 1000) * 100) / 100;
      } else {
        distanceKm = calculateDistanceKm(
          { latitude, longitude },
          { latitude: placeLat, longitude: placeLon }
        );
        distanceMeters = Math.round(distanceKm * 1000);
      }

      candidates.push({
        id,
        name,
        formattedAddress,
        street: props.street,
        city: props.city,
        state: props.state,
        postalCode: props.postcode,
        country: props.country,
        latitude: placeLat,
        longitude: placeLon,
        distanceKm,
        distanceMeters,
        categories: Array.isArray(props.categories) ? props.categories : [],
        source: 'geoapify',
        phone: props.contact?.phone,
        email: props.contact?.email,
        website: props.website,
      });
    }

    return candidates;
  }
}

