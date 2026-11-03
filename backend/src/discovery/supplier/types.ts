/**
 * Canonical geographic coordinates (WGS84).
 * Coordinates are the canonical location representation across Relay.
 */
export interface SupplierDiscoveryCoordinates {
  latitude: number;
  longitude: number;
}

/**
 * Normalized runtime query parameters for discovering local suppliers.
 * Strictly location-agnostic: relies on coordinates, not city names.
 */
export interface SupplierDiscoveryQuery {
  /**
   * Canonical geographic coordinates (latitude, longitude).
   * Latitude: [-90, 90], Longitude: [-180, 180].
   */
  coordinates: SupplierDiscoveryCoordinates;

  /**
   * Search radius in meters. Must be > 0.
   * Default: 5000 (5km) if omitted.
   */
  radiusMeters?: number;

  /**
   * Optional search criteria, product name, or keywords (e.g. "rice", "wheat", "wholesale groceries").
   */
  searchTerm?: string;

  /**
   * Optional category filter(s) for the provider.
   * (e.g., commercial.supermarket, commercial.wholesale, commercial.food_and_drink)
   */
  categories?: string[];

  /**
   * Maximum number of candidates to return (default 20, max 100).
   */
  limit?: number;
}

/**
 * Normalized Relay domain entity representing a discovered supplier candidate.
 * Shields Relay from vendor-specific response formats.
 */
export interface SupplierCandidate {
  /**
   * Stable identifier across searches (e.g. Geoapify place_id or mock ID).
   */
  id: string;

  /**
   * Supplier or commercial business name.
   */
  name: string;

  /**
   * Full human-readable formatted address.
   */
  formattedAddress: string;

  /**
   * Granular address components (optional).
   */
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;

  /**
   * Geographic location of the supplier.
   */
  latitude: number;
  longitude: number;

  /**
   * Distance from search origin in kilometers (rounded to 2 decimal places).
   */
  distanceKm: number;

  /**
   * Distance from search origin in meters.
   */
  distanceMeters: number;

  /**
   * Commercial / business categories assigned by the provider.
   */
  categories: string[];

  /**
   * Discovery provider source ('geoapify', 'mock', etc.).
   */
  source: string;

  /**
   * Contact details when provided by the vendor.
   */
  phone?: string;
  email?: string;
  website?: string;
}

/**
 * Configuration options for GeoapifySupplierProvider.
 */
export interface GeoapifyProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

