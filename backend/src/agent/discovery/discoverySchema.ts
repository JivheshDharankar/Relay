import { z } from 'zod';
import { ToolDefinition } from '../model/types';
import { CategoryMappingRegistry } from '../../discovery/supplier/qualification/categoryMapping';

/**
 * Phase 14.3 — AI discovery-planning contract.
 *
 * Meta proposes HOW Relay should search (search terms, categories, supplier
 * types). Relay validates the proposal against its own supported vocabulary
 * and hard constraints, then builds the real provider query itself. The model
 * can never supply supplier identities, prices, availability, or auth claims:
 * the strict schemas below have no such fields.
 */

export const DISCOVERY_TOOL_NAME = 'propose_discovery_plan';

export const DEFAULT_DISCOVERY_RADIUS_KM = 5;
export const MAX_DISCOVERY_RADIUS_KM = 25;

export const MAX_SEARCH_TERMS_PER_ITEM = 8;
export const MAX_SEARCH_TERM_LENGTH = 80;
export const MAX_CATEGORIES_PER_ITEM = 6;
export const MAX_CATEGORY_LENGTH = 64;
export const MAX_SUPPLIER_TYPES_PER_ITEM = 6;

export const SUPPORTED_SUPPLIER_TYPES = [
  'wholesale',
  'retail',
  'supermarket',
  'grocery',
  'market',
  'marketplace',
  'distributor',
  'dealer',
  'cooperative',
  'hypermarket',
  'department_store',
  'discount_store',
  'chemist',
  'manufacturer',
  'general_store',
  'food_supplier',
  'kirana',
] as const;

const SAFE_CATEGORY_PATTERN = /^[A-Za-z][A-Za-z0-9_.]*$/;

function tokenizeCategory(category: string): string[] {
  const tokens = new Set<string>();
  for (const segment of category.toLowerCase().split('.')) {
    if (segment.length > 0) tokens.add(segment);
    for (const part of segment.split(/[\s\-/]+/)) {
      if (part.length > 0) tokens.add(part);
    }
  }
  return Array.from(tokens);
}

/**
 * Union of category tokens Relay's deterministic qualification considers
 * relevant, across all catalog mappings. Computed per call so test-registered
 * custom mappings are respected.
 */
export function getSupportedCategoryTokens(): Set<string> {
  const tokens = new Set<string>();
  for (const key of ['grains & staples', 'oils & ghee', 'household cleaning', '']) {
    for (const token of CategoryMappingRegistry.resolve(key).relevantTokens) {
      tokens.add(token.toLowerCase());
    }
  }
  return tokens;
}

export function getIncompatibleCategoryTokens(): Set<string> {
  return new Set(
    CategoryMappingRegistry.resolve('').incompatibleTokens.map((t) => t.toLowerCase())
  );
}

export interface CategoryValidation {
  valid: boolean;
  reason?: string;
}

/**
 * Deterministic category check: safe shape, at least one Relay-supported
 * token, and zero incompatible tokens.
 */
export function validateDiscoveryCategory(category: string): CategoryValidation {
  if (!SAFE_CATEGORY_PATTERN.test(category)) {
    return { valid: false, reason: `Category "${category}" has an unsafe shape.` };
  }
  const tokens = tokenizeCategory(category);
  const supported = getSupportedCategoryTokens();
  const incompatible = getIncompatibleCategoryTokens();
  for (const token of tokens) {
    if (incompatible.has(token)) {
      return {
        valid: false,
        reason: `Category "${category}" contains incompatible token "${token}".`,
      };
    }
  }
  if (!tokens.some((t) => supported.has(t))) {
    return {
      valid: false,
      reason: `Category "${category}" contains no Relay-supported token.`,
    };
  }
  return { valid: true };
}

/**
 * Normalizes a proposed supplier type to canonical vocabulary form.
 * Returns null when the type is outside Relay's supported vocabulary.
 */
export function normalizeSupplierType(raw: string): string | null {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, '_');
  const match = (SUPPORTED_SUPPLIER_TYPES as readonly string[]).find(
    (t) => t === normalized
  );
  return match ?? null;
}

const rawPlanItemSchema = z
  .object({
    productId: z.string().min(1).max(64),
    productName: z.string().min(1).max(120),
    quantity: z.number(),
    unit: z.string().min(1).max(16),
    searchTerms: z
      .array(
        z
          .string()
          .min(1)
          .max(MAX_SEARCH_TERM_LENGTH)
          .refine((s) => s.trim().length > 0 && !/[\x00-\x1F\x7F]/.test(s), {
            message: 'Search term must be non-blank printable text.',
          })
      )
      .min(1)
      .max(MAX_SEARCH_TERMS_PER_ITEM),
    categories: z.array(z.string().min(1).max(MAX_CATEGORY_LENGTH)).min(1).max(MAX_CATEGORIES_PER_ITEM),
    supplierTypes: z
      .array(z.string().min(1).max(40))
      .min(1)
      .max(MAX_SUPPLIER_TYPES_PER_ITEM),
  })
  .strict();

const rawPlanGeographySchema = z
  .object({
    radiusKm: z.number().finite().positive().optional(),
    expansionAllowed: z.boolean().optional(),
  })
  .strict();

const rawPlanFulfillmentSchema = z
  .object({
    maxHours: z.number().finite().positive(),
  })
  .strict();

const rawPlanStrategySchema = z
  .object({
    prioritizeLocal: z.boolean().optional(),
    considerWholesale: z.boolean().optional(),
    considerRetail: z.boolean().optional(),
  })
  .strict();

export const rawDiscoveryPlanSchema = z
  .object({
    items: z.array(rawPlanItemSchema).min(1).max(20),
    geography: rawPlanGeographySchema.optional(),
    fulfillment: rawPlanFulfillmentSchema.optional(),
    strategy: rawPlanStrategySchema.optional(),
  })
  .strict();

export type RawDiscoveryPlanItem = z.infer<typeof rawPlanItemSchema>;
export type RawDiscoveryPlan = z.infer<typeof rawDiscoveryPlanSchema>;

/**
 * Inference-only tool definition for discovery planning.
 * Deliberately NOT registered in the executable ToolRegistry.
 */
export const PROPOSE_DISCOVERY_PLAN_TOOL: ToolDefinition = {
  name: DISCOVERY_TOOL_NAME,
  description:
    'Propose a supplier discovery plan for a validated procurement intent. Call exactly once.',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'One strategy per validated intent item, same products and quantities.',
      },
      geography: {
        type: 'object',
        description: 'Optional search radius in km (Relay maximum applies).',
      },
      fulfillment: {
        type: 'object',
        description: 'Optional deadline in hours; must not exceed the intent deadline.',
      },
      strategy: {
        type: 'object',
        description: 'Optional local/wholesale/retail preference flags.',
      },
    },
    required: ['items'],
  },
};

export const DISCOVERY_PLANNING_SYSTEM_PROMPT = [
  'You plan supplier discovery for the Relay community procurement platform.',
  'You receive a validated procurement intent as JSON. You MUST call the propose_discovery_plan function exactly once and MUST NOT reply in prose.',
  'Rules:',
  '1. Include exactly one plan item per intent item: copy productId, quantity, and unit EXACTLY as given. Never change, merge, or invent products or quantities.',
  '2. productName must match the intent item product or canonical name.',
  '3. searchTerms: 1-8 short terms per item (product and trade phrases only).',
  '4. categories: 1-6 Geoapify-style commercial categories per item (e.g. commercial.supermarket, commercial.wholesale, commercial.food_and_drink, commercial.marketplace, commercial.chemist, commercial.department_store).',
  `5. supplierTypes: 1-6 values from: ${(SUPPORTED_SUPPLIER_TYPES as readonly string[]).join(', ')}.`,
  `6. geography.radiusKm is optional; when set it must be over 0 and at most ${MAX_DISCOVERY_RADIUS_KM}. Omit it to let Relay use its default.`,
  '7. fulfillment.maxHours is optional; when the intent states a deadline it must not exceed that deadline. When the intent has no deadline, omit fulfillment entirely.',
  '8. NEVER include supplier IDs, supplier names, addresses, phones, ratings, reliability, prices, availability, SLAs, delivery promises, payment amounts, or authorization claims. Those come from Relay providers, never from you.',
].join('\n');
