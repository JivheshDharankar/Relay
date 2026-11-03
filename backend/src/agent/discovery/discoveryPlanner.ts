import { ZodError } from 'zod';
import { ProductUnit } from '@prisma/client';
import { ModelProvider, ModelProviderError, getModelProvider } from '../model';
import {
  ValidatedIntent,
  ValidatedIntentItem,
} from '../intent/intentExtractor';
import {
  SupplierDiscoveryQuery,
  SupplierDiscoveryCoordinates,
} from '../../discovery/supplier/types';
import {
  DEFAULT_DISCOVERY_RADIUS_KM,
  DISCOVERY_PLANNING_SYSTEM_PROMPT,
  DISCOVERY_TOOL_NAME,
  MAX_DISCOVERY_RADIUS_KM,
  PROPOSE_DISCOVERY_PLAN_TOOL,
  RawDiscoveryPlan,
  normalizeSupplierType,
  rawDiscoveryPlanSchema,
  validateDiscoveryCategory,
} from './discoverySchema';

export type DiscoveryPlanStatus = 'ok' | 'invalid' | 'error';

export interface ValidatedDiscoveryItem {
  productId: string | null;
  productName: string;
  quantity: number;
  unit: ProductUnit;
  searchTerms: string[];
  categories: string[];
  supplierTypes: string[];
}

export interface ValidatedDiscoveryPlan {
  items: ValidatedDiscoveryItem[];
  geography: { radiusKm: number; expansionAllowed: boolean };
  fulfillment?: { maxHours: number };
  strategy?: {
    prioritizeLocal?: boolean;
    considerWholesale?: boolean;
    considerRetail?: boolean;
  };
}

export interface DiscoveryPlanIssue {
  code: string;
  message: string;
  itemIndex?: number;
}

export interface DiscoveryPlanResult {
  status: DiscoveryPlanStatus;
  plan?: ValidatedDiscoveryPlan;
  issues: DiscoveryPlanIssue[];
}

export interface DiscoveryPlannerConfig {
  maxRadiusKm?: number;
  defaultRadiusKm?: number;
}

export class DiscoveryPlanError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DiscoveryPlanError';
    this.code = code;
  }
}

type ResolvedIntentItem = ValidatedIntentItem & {
  quantity: number;
  unit: ProductUnit;
  resolution: {
    status: 'resolved';
    productId: string | null;
    canonicalName: string;
    identitySource: 'catalog' | 'open-world';
  };
};

/**
 * Stable match key for pairing plan items with intent items. Catalog items
 * match by product ID; open-world items (no authoritative ID) match by
 * canonical name, keeping distinct products in separate groups.
 */
function matchKey(item: ResolvedIntentItem): string {
  return item.resolution.productId ?? item.resolution.canonicalName;
}

function asResolvedItems(intent: ValidatedIntent): ResolvedIntentItem[] | null {
  if (!intent.items || intent.items.length === 0) return null;
  const resolved: ResolvedIntentItem[] = [];
  for (const item of intent.items) {
    if (
      item.resolution.status !== 'resolved' ||
      item.quantity === undefined ||
      item.unit === undefined
    ) {
      return null;
    }
    resolved.push(item as ResolvedIntentItem);
  }
  return resolved;
}

function mapZodIssues(error: ZodError): DiscoveryPlanIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    const itemIndex =
      typeof issue.path[0] === 'string' &&
      issue.path[0] === 'items' &&
      typeof issue.path[1] === 'number'
        ? issue.path[1]
        : undefined;
    if (issue.code === 'unrecognized_keys') {
      return {
        code: 'EXTRA_FIELD',
        message: `Discovery plan contains unauthorized field(s) at ${path || 'root'}: ${issue.keys.join(', ')}`,
        itemIndex,
      };
    }
    return {
      code: 'SCHEMA_VIOLATION',
      message: `Discovery plan failed validation at ${path || 'root'}: ${issue.message}`,
      itemIndex,
    };
  });
}

/**
 * Phase 14.3 — deterministic discovery-planning service.
 *
 * Flow: validated intent → model proposes a discovery plan via ONE
 * inference-only tool call → deterministic validation against the intent,
 * Relay vocabulary, and Relay constraints → validated plan. Relay then builds
 * the real provider queries itself via buildDiscoveryQueries. Nothing here
 * contacts suppliers, qualifies them, or mutates procurement state.
 */
export class DiscoveryPlanner {
  private provider: ModelProvider;
  private readonly maxRadiusKm: number;
  private readonly defaultRadiusKm: number;

  constructor(options?: { provider?: ModelProvider } & DiscoveryPlannerConfig) {
    this.provider = options?.provider ?? getModelProvider();
    this.maxRadiusKm = options?.maxRadiusKm ?? MAX_DISCOVERY_RADIUS_KM;
    this.defaultRadiusKm = options?.defaultRadiusKm ?? DEFAULT_DISCOVERY_RADIUS_KM;
  }

  public async plan(intent: ValidatedIntent): Promise<DiscoveryPlanResult> {
    const resolved = asResolvedItems(intent);
    if (!resolved) {
      return {
        status: 'invalid',
        issues: [
          {
            code: 'UNRESOLVED_INTENT',
            message: 'Discovery planning requires a fully resolved intent.',
          },
        ],
      };
    }

    let response;
    try {
      response = await this.provider.generateWithTools({
        messages: [
          { role: 'system', content: DISCOVERY_PLANNING_SYSTEM_PROMPT },
          { role: 'user', content: this.renderIntentPrompt(intent, resolved) },
        ],
        tools: [PROPOSE_DISCOVERY_PLAN_TOOL],
        temperature: 0.1,
        // Observed: ~560+ reasoning tokens for a 3-item plan against a 1024
        // budget truncates to finish_reason=length with no tool call. 2048
        // leaves headroom for reasoning plus the emitted call.
        maxTokens: 2048,
        reasoningEffort: 'low',
      });
    } catch (err) {
      if (err instanceof ModelProviderError) {
        return { status: 'error', issues: [{ code: err.code, message: err.message }] };
      }
      return {
        status: 'error',
        issues: [
          {
            code: 'PROVIDER_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }

    const planCalls = (response.toolCalls ?? []).filter((c) => c.name === DISCOVERY_TOOL_NAME);
    if (planCalls.length === 0) {
      return {
        status: 'invalid',
        issues: [
          {
            code: 'NO_TOOL_CALL',
            message: 'Model did not return a discovery-plan tool call.',
          },
        ],
      };
    }
    if (planCalls.length > 1) {
      return {
        status: 'invalid',
        issues: [
          {
            code: 'MULTIPLE_TOOL_CALLS',
            message: 'Model returned more than one discovery-plan tool call.',
          },
        ],
      };
    }

    const parsed = rawDiscoveryPlanSchema.safeParse(planCalls[0].arguments);
    if (!parsed.success) {
      return { status: 'invalid', issues: mapZodIssues(parsed.error) };
    }
    return this.validateAgainstIntent(parsed.data, resolved, intent);
  }

  private renderIntentPrompt(intent: ValidatedIntent, resolved: ResolvedIntentItem[]): string {
    const payload = {
      items: resolved.map((item) => ({
        productId: matchKey(item),
        productName: item.productName,
        canonicalName: item.resolution.canonicalName,
        quantity: item.quantity,
        unit: item.unit,
      })),
      deadline: intent.deadline,
      payment: intent.payment,
    };
    return (
      `Validated procurement intent (JSON):\n${JSON.stringify(payload)}\n\n` +
      'Call propose_discovery_plan now with a discovery strategy for exactly these items.'
    );
  }

  private validateAgainstIntent(
    raw: RawDiscoveryPlan,
    resolved: ResolvedIntentItem[],
    intent: ValidatedIntent
  ): DiscoveryPlanResult {
    const issues: DiscoveryPlanIssue[] = [];

    // 1. Item multiset must match the intent exactly (no invention, no drops, no merges).
    const remaining = new Map<string, ResolvedIntentItem[]>();
    for (const item of resolved) {
      const key = matchKey(item);
      const group = remaining.get(key) ?? [];
      group.push(item);
      remaining.set(key, group);
    }
    const pairs: Array<{ intentItem: ResolvedIntentItem; planIndex: number }> = [];
    raw.items.forEach((planItem, planIndex) => {
      const group = remaining.get(planItem.productId);
      if (!group || group.length === 0) {
        issues.push({
          code: 'UNKNOWN_PRODUCT',
          message: `Plan item ${planIndex} references product not in the validated intent.`,
          itemIndex: planIndex,
        });
        return;
      }
      pairs.push({ intentItem: group.shift() as ResolvedIntentItem, planIndex });
    });
    for (const leftover of remaining.values()) {
      for (const item of leftover) {
        issues.push({
          code: 'MISSING_ITEM',
          message: `Validated intent product "${item.resolution.canonicalName}" has no plan item.`,
        });
      }
    }
    if (issues.length > 0) {
      return { status: 'invalid', issues };
    }

    // 2. Per-item cross-checks against the paired intent item.
    const items: ValidatedDiscoveryItem[] = [];
    for (const { intentItem, planIndex } of pairs) {
      const planItem = raw.items[planIndex];
      const expectedNames = [
        intentItem.productName.toLowerCase(),
        intentItem.resolution.canonicalName.toLowerCase(),
      ];
      if (!expectedNames.includes(planItem.productName.toLowerCase())) {
        issues.push({
          code: 'PRODUCT_MISMATCH',
          message: `Plan item ${planIndex} product name does not match the validated intent.`,
          itemIndex: planIndex,
        });
        continue;
      }
      if (planItem.quantity !== intentItem.quantity) {
        issues.push({
          code: 'QUANTITY_TAMPERED',
          message: `Plan item ${planIndex} quantity differs from the validated intent.`,
          itemIndex: planIndex,
        });
        continue;
      }
      if (planItem.unit !== intentItem.unit) {
        issues.push({
          code: 'UNIT_TAMPERED',
          message: `Plan item ${planIndex} unit differs from the validated intent.`,
          itemIndex: planIndex,
        });
        continue;
      }
      for (const category of planItem.categories) {
        const check = validateDiscoveryCategory(category);
        if (!check.valid) {
          issues.push({
            code: 'UNSUPPORTED_CATEGORY',
            message: `Plan item ${planIndex}: ${check.reason}`,
            itemIndex: planIndex,
          });
        }
      }
      const supplierTypes: string[] = [];
      for (const type of planItem.supplierTypes) {
        const normalized = normalizeSupplierType(type);
        if (!normalized) {
          issues.push({
            code: 'UNSUPPORTED_SUPPLIER_TYPE',
            message: `Plan item ${planIndex} uses unsupported supplier type "${type}".`,
            itemIndex: planIndex,
          });
        } else {
          supplierTypes.push(normalized);
        }
      }
      if (issues.some((i) => i.itemIndex === planIndex)) {
        continue;
      }
      items.push({
        productId: intentItem.resolution.productId,
        productName: planItem.productName,
        quantity: intentItem.quantity,
        unit: intentItem.unit,
        searchTerms: planItem.searchTerms.map((t) => t.trim()),
        categories: [...planItem.categories],
        supplierTypes,
      });
    }
    if (issues.length > 0) {
      return { status: 'invalid', issues };
    }

    // 3. Geography: Relay maximum applies; absent radius falls back to default.
    let radiusKm = this.defaultRadiusKm;
    let expansionAllowed = false;
    if (raw.geography?.radiusKm !== undefined) {
      if (raw.geography.radiusKm > this.maxRadiusKm) {
        return {
          status: 'invalid',
          issues: [
            {
              code: 'RADIUS_EXCEEDED',
              message: `Proposed radius ${raw.geography.radiusKm}km exceeds Relay maximum of ${this.maxRadiusKm}km.`,
            },
          ],
        };
      }
      radiusKm = raw.geography.radiusKm;
    }
    if (raw.geography?.expansionAllowed !== undefined) {
      expansionAllowed = raw.geography.expansionAllowed;
    }

    // 4. Fulfillment: the model can only tighten, never expand or invent.
    let fulfillment: { maxHours: number } | undefined;
    if (raw.fulfillment?.maxHours !== undefined) {
      if (intent.deadline === undefined) {
        return {
          status: 'invalid',
          issues: [
            {
              code: 'INVENTED_DEADLINE',
              message: 'Plan invents a deadline the validated intent does not state.',
            },
          ],
        };
      }
      if (raw.fulfillment.maxHours > intent.deadline.maxHours) {
        return {
          status: 'invalid',
          issues: [
            {
              code: 'DEADLINE_EXPANDED',
              message: `Proposed deadline ${raw.fulfillment.maxHours}h exceeds intent deadline ${intent.deadline.maxHours}h.`,
            },
          ],
        };
      }
      fulfillment = { maxHours: raw.fulfillment.maxHours };
    } else if (intent.deadline !== undefined) {
      fulfillment = { maxHours: intent.deadline.maxHours };
    }

    // Keep validated items aligned with intent order for determinism.
    const order = new Map<string, number>();
    resolved.forEach((item, index) => {
      const key = matchKey(item);
      if (!order.has(key)) {
        order.set(key, index);
      }
    });
    items.sort(
      (a, b) =>
        (order.get(a.productId ?? a.productName) ?? 0) -
        (order.get(b.productId ?? b.productName) ?? 0)
    );

    return {
      status: 'ok',
      plan: {
        items,
        geography: { radiusKm, expansionAllowed },
        fulfillment,
        strategy: raw.strategy,
      },
      issues: [],
    };
  }
}

export interface DiscoveryQueryContext {
  coordinates: SupplierDiscoveryCoordinates;
  limit?: number;
}

/**
 * Deterministically builds one real provider query per planned item.
 * Coordinates, radius bounds, and limits come from Relay runtime inputs —
 * never from the model. The model contributes only validated search terms
 * and categories.
 */
export function buildDiscoveryQueries(
  plan: ValidatedDiscoveryPlan,
  ctx: DiscoveryQueryContext
): SupplierDiscoveryQuery[] {
  const { latitude, longitude } = ctx.coordinates || {};
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new DiscoveryPlanError(
      'INVALID_COORDINATES',
      'Discovery queries require valid Relay runtime coordinates.'
    );
  }
  const limit = ctx.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new DiscoveryPlanError(
      'INVALID_LIMIT',
      'Discovery query limit must be an integer between 1 and 100.'
    );
  }
  return plan.items.map((item) => ({
    coordinates: { latitude, longitude },
    radiusMeters: Math.round(plan.geography.radiusKm * 1000),
    searchTerm: item.searchTerms[0],
    categories: [...item.categories],
    limit,
  }));
}
