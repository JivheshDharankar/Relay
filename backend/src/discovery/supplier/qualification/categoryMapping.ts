/**
 * Mapping specification from high-level procurement categories to acceptable/incompatible supplier category tokens.
 * Completely vendor-agnostic: matches on normalized semantic tokens rather than Geoapify-specific schemas.
 */
export interface ProcurementCategoryMapping {
  /**
   * Category tokens that strongly indicate commercial relevance to the product.
   */
  relevantTokens: string[];

  /**
   * Category tokens that clearly indicate an incompatible business type (e.g. dine-in restaurants, cinemas).
   */
  incompatibleTokens: string[];
}

/**
 * Common incompatible business categories across all retail bulk grocery & household procurement.
 */
const COMMON_INCOMPATIBLE_TOKENS = [
  'restaurant',
  'fast_food',
  'cafe',
  'bar',
  'pub',
  'cinema',
  'theater',
  'museum',
  'hotel',
  'motel',
  'bank',
  'atm',
  'hospital',
  'clinic',
  'pharmacy_hospital',
  'clothing',
  'fashion',
  'shoes',
  'vehicle',
  'car_repair',
  'fuel',
  'gas_station',
  'fitness',
  'gym',
];

/**
 * Standard category mappings justified by the current Relay standardized catalog:
 * - Grains & Staples (Basmati Rice, Sharbati Whole Wheat Atta)
 * - Oils & Ghee (Cold-Pressed Sunflower Cooking Oil)
 * - Household Cleaning (Eco Clean Laundry Detergent)
 */
const DEFAULT_CATALOG_MAPPINGS: Record<string, ProcurementCategoryMapping> = {
  'grains & staples': {
    relevantTokens: [
      'wholesale',
      'supermarket',
      'food_and_drink',
      'food',
      'grocery',
      'marketplace',
      'discount_store',
      'grain',
      'staples',
    ],
    incompatibleTokens: COMMON_INCOMPATIBLE_TOKENS,
  },
  'oils & ghee': {
    relevantTokens: [
      'wholesale',
      'supermarket',
      'food_and_drink',
      'food',
      'grocery',
      'marketplace',
      'discount_store',
      'oil',
    ],
    incompatibleTokens: COMMON_INCOMPATIBLE_TOKENS,
  },
  'household cleaning': {
    relevantTokens: [
      'wholesale',
      'supermarket',
      'chemist',
      'discount_store',
      'marketplace',
      'department_store',
      'grocery',
      'household',
      'cleaning',
    ],
    incompatibleTokens: COMMON_INCOMPATIBLE_TOKENS,
  },
  // Generic fallback for any arbitrary grocery/commodity procurement
  default: {
    relevantTokens: [
      'wholesale',
      'supermarket',
      'food_and_drink',
      'food',
      'grocery',
      'marketplace',
      'discount_store',
      'department_store',
    ],
    incompatibleTokens: COMMON_INCOMPATIBLE_TOKENS,
  },
};

/**
 * Extensible registry for mapping product names or categories to procurement criteria.
 */
export class CategoryMappingRegistry {
  private static customMappings = new Map<string, ProcurementCategoryMapping>();

  /**
   * Registers a custom mapping for a specific procurement category or product keyword.
   */
  public static register(key: string, mapping: ProcurementCategoryMapping): void {
    this.customMappings.set(key.toLowerCase().trim(), mapping);
  }

  /**
   * Clears custom mappings (useful in tests).
   */
  public static clear(): void {
    this.customMappings.clear();
  }

  /**
   * Resolves the appropriate category mapping for a given product name or procurement category.
   */
  public static resolve(productOrCategory?: string): ProcurementCategoryMapping {
    if (!productOrCategory || productOrCategory.trim().length === 0) {
      return DEFAULT_CATALOG_MAPPINGS['default'];
    }

    const normalized = productOrCategory.toLowerCase().trim();

    // 1. Direct match in custom mappings
    if (this.customMappings.has(normalized)) {
      return this.customMappings.get(normalized)!;
    }

    // 2. Direct match in standard catalog
    if (DEFAULT_CATALOG_MAPPINGS[normalized]) {
      return DEFAULT_CATALOG_MAPPINGS[normalized];
    }

    // 3. Keyword heuristic for Relay standard catalog products
    if (
      normalized.includes('rice') ||
      normalized.includes('wheat') ||
      normalized.includes('atta') ||
      normalized.includes('grain') ||
      normalized.includes('flour') ||
      normalized.includes('staple')
    ) {
      return DEFAULT_CATALOG_MAPPINGS['grains & staples'];
    }

    if (
      normalized.includes('oil') ||
      normalized.includes('ghee') ||
      normalized.includes('sunflower')
    ) {
      return DEFAULT_CATALOG_MAPPINGS['oils & ghee'];
    }

    if (
      normalized.includes('detergent') ||
      normalized.includes('cleaning') ||
      normalized.includes('soap') ||
      normalized.includes('cleaner')
    ) {
      return DEFAULT_CATALOG_MAPPINGS['household cleaning'];
    }

    // 4. Default fallback
    return DEFAULT_CATALOG_MAPPINGS['default'];
  }
}

export interface CategoryMatchResult {
  outcome: 'CATEGORY_MATCH' | 'CATEGORY_MISMATCH' | 'CATEGORY_UNKNOWN';
  matchedTokens: string[];
}

/**
 * Deterministically checks candidate category tags against the resolved procurement mapping.
 */
export function matchSupplierCategories(
  candidateCategories: string[],
  mapping: ProcurementCategoryMapping
): CategoryMatchResult {
  if (!candidateCategories || candidateCategories.length === 0) {
    return { outcome: 'CATEGORY_UNKNOWN', matchedTokens: [] };
  }

  // Tokenize categories (e.g. 'commercial.supermarket' -> ['commercial', 'supermarket'])
  const tokenSet = new Set<string>();
  for (const cat of candidateCategories) {
    if (typeof cat !== 'string') continue;
    const parts = cat.toLowerCase().split(/[._\s\-/]+/);
    for (const p of parts) {
      if (p.length > 0) tokenSet.add(p);
    }
  }

  if (tokenSet.size === 0) {
    return { outcome: 'CATEGORY_UNKNOWN', matchedTokens: [] };
  }

  // If only generic uninformative tags (e.g. 'commercial' only), category is UNKNOWN
  const informativeTokens = Array.from(tokenSet).filter((t) => t !== 'commercial');
  if (informativeTokens.length === 0) {
    return { outcome: 'CATEGORY_UNKNOWN', matchedTokens: [] };
  }

  // 1. Check for relevant matches
  const matchedTokens: string[] = [];
  for (const token of tokenSet) {
    if (mapping.relevantTokens.includes(token)) {
      matchedTokens.push(token);
    }
  }

  if (matchedTokens.length > 0) {
    return { outcome: 'CATEGORY_MATCH', matchedTokens };
  }

  // 2. Check for clear incompatibilities
  for (const token of tokenSet) {
    if (mapping.incompatibleTokens.includes(token)) {
      return { outcome: 'CATEGORY_MISMATCH', matchedTokens: [] };
    }
  }

  // 3. Neither explicitly matched nor explicitly incompatible -> UNKNOWN (needs RFQ)
  return { outcome: 'CATEGORY_UNKNOWN', matchedTokens: [] };
}

