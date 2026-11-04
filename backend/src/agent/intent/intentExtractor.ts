import { ZodError } from 'zod';
import { ProductUnit } from '@prisma/client';
import { toDecimal } from '../../domain/procurement/decimal';
import { ModelProvider, ModelProviderError, getModelProvider } from '../model';
import { ParsedResidentIntent } from '../../orchestration/types';
import {
  EXTRACT_INTENT_TOOL,
  INTENT_EXTRACTION_SYSTEM_PROMPT,
  INTENT_TOOL_NAME,
  MandateType,
  MAX_INTENT_ITEMS,
  MAX_PRODUCT_NAME_LENGTH,
  MAX_QUANTITY,
  RawIntentItem,
  isDozenUnitWord,
  normalizeIntentUnit,
  rawIntentSchema,
  singularizeContainerWord,
} from './intentSchema';
import { matchCatalogProduct } from './catalogMatcher';
import { findPriceSpans, splitQuantitySegments } from './quantitySegments';
import {
  detectAmbiguousQuantityPhrasing,
  detectContradictoryDeliveryPhrasing,
  normalizeDevanagariNumerals,
  normalizeIndicNumberWords,
} from './multilingual';

export type IntentStatus = 'ok' | 'unresolved' | 'invalid' | 'error';

export type ItemResolution =
  | {
      status: 'resolved';
      productId: string | null;
      canonicalName: string;
      identitySource: 'catalog' | 'open-world';
    }
  | {
      status: 'unresolved';
      reason: 'UNMAPPABLE_PRODUCT' | 'MISSING_QUANTITY' | 'MISSING_UNIT' | 'AMBIGUOUS_REFERENCE';
    };

export interface ValidatedIntentItem {
  productName: string;
  quantity?: number;
  unit?: ProductUnit;
  rawUnit?: string;
  /** Verbatim stated semantic cues; descriptive only, never authoritative facts. */
  brand?: string;
  packaging?: string;
  packSize?: string;
  priceCue?: string;
  variant?: string;
  constraints: string[];
  preferences?: string;
  notes?: string;
  resolution: ItemResolution;
}

export interface ValidatedIntent {
  originalRequest: string;
  items: ValidatedIntentItem[];
  deadline?: { maxHours: number };
  payment?: { mandateType?: MandateType };
}

export interface IntentIssue {
  code: string;
  message: string;
  itemIndex?: number;
}

export interface IntentExtractionResult {
  status: IntentStatus;
  intent?: ValidatedIntent;
  issues: IntentIssue[];
}

const MAX_REQUEST_CHARS = 5000;

/**
 * Deterministic, language-agnostic tripwire for product-identity override
 * instructions embedded in the request text (e.g. "use productId sugar-123",
 * "treat icecream as sugar"). Product-agnostic: it matches override
 * PHRASING, never product names. Runs before any model call so an injected
 * instruction can never shape the extraction.
 */
function detectIdentityOverrideInstruction(requestText: string): boolean {
  return (
    /\bproduct\s*-?\s*id\b/i.test(requestText) ||
    /\btreat\s+\S+\s+as\b/i.test(requestText) ||
    /\b\w+\s+means\s+\w+/i.test(requestText)
  );
}

/**
 * Pre-model tripwire for negative quantities ("-5 kg", "minus 5 kg").
 * The minus must start the text or follow whitespace, so ranges ("2-3 kg")
 * and product codes ("WD-40") never trip it. Runs before any model call
 * so a dropped minus can never become a silently substituted quantity.
 */
function detectNegativeQuantity(requestText: string): boolean {
  return /(^|\s)-\s*\d|\bminus\s+\d/i.test(requestText);
}

/**
 * Deterministic sanitizer for open-world (non-catalog) product names proposed
 * by the model. Returns the canonical name, or null when the meaning itself
 * is unreliable (empty, or no letters at all). Accepts any script: the model
 * is instructed to emit English, but Relay validates structure, not language.
 */
/**
 * Names that refer to a product without naming one ("that one",
 * "the cheaper one", "the same"). Purely grammatical (demonstratives,
 * comparatives, determiners) — no product vocabulary. Such items are
 * referentially ambiguous no matter what quantity or unit accompanies
 * them, because Relay cannot know WHICH product is meant.
 */
const BARE_REFERENCE_NAMES = new Set([
  'one',
  'ones',
  'that one',
  'this one',
  'the one',
  'it',
  'that',
  'this',
  'them',
  'those',
  'these',
  'that stuff',
  'this stuff',
  'around',
  'approx',
  'maybe',
  'chahiye',
  'pahije',
  'हवे आहेत',
  'हवा आहे',
  'हवी आहे',
  'चाहिए',
  'मुझे',
  'हमें',
  'मला',
  'आम्हाला',
  'नहीं',
  'नाही',
  'नको',
  'nahi',
  'nahin',
  'nako',
]);

/**
 * Placeholder names a model may emit when the request states a quantity
 * but no product ("5 kg" → "unspecified goods"). Accepting these as
 * open-world items would procure phantom products, so they clarify.
 */
const PLACEHOLDER_PRODUCT_NAMES = new Set([
  'unspecified',
  'unspecified goods',
  'unspecified item',
  'unknown',
  'unknown product',
  'unknown item',
  'miscellaneous',
  'general',
  'general items',
  'item',
  'items',
  'product',
  'products',
  'goods',
  'stuff',
  'things',
]);

const REFERENTIAL_ONE_PATTERN =
  /^(the|a|an|that|this)?\s*(\w+(er|est)|best|worst|usual|same|other|blue|red|green|black|white|yellow|pink|purple|brown|orange)\s+ones?$/i;

const BARE_DETERMINER_REFERENCE_PATTERN = /^(the|that|this)\s+(same|usual|other)$/i;

export function isReferentiallyAmbiguous(productName: string): boolean {
  const cleaned = productName.trim().toLowerCase().replace(/\s+/g, ' ');
  return (
    BARE_REFERENCE_NAMES.has(cleaned) ||
    PLACEHOLDER_PRODUCT_NAMES.has(cleaned) ||
    REFERENTIAL_ONE_PATTERN.test(cleaned) ||
    BARE_DETERMINER_REFERENCE_PATTERN.test(cleaned)
  );
}

/**
 * Deep-strips explicit JSON nulls from model tool-call arguments before
 * validation. Providers intermittently serialize omitted optional fields as
 * null ("brand": null); that means "not stated", never a value Relay should
 * reject or invent. Only nulls are dropped — every stated value is preserved
 * byte-for-byte, and required-field/absent-quantity rules still apply after.
 */
function stripExplicitNulls(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== null).map(stripExplicitNulls);
  }
  if (typeof value === 'object') {
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === null) continue;
      cleaned[key] = stripExplicitNulls(entry);
    }
    return cleaned;
  }
  return value;
}

/**
 * Deterministic repair for a model-emitted item whose product name embeds
 * further quantity-led segments ("cola 2 bottles juice" emitted as one
 * item). Re-splits with the shared structural rule so a model blob is
 * never discarded whole: the first piece keeps the model's quantity, unit,
 * and cues, later pieces carry the quantities stated in the text. Split
 * pieces flow through normal validation, so genuinely missing facts still
 * surface as targeted clarification. Never invents: quantities come from
 * the text, and anything unclean stays a single item.
 */
function repairBlobItems(items: RawIntentItem[]): RawIntentItem[] {
  const out: RawIntentItem[] = [];
  for (const raw of items) {
    const spans = findPriceSpans(raw.productName);
    const rawUnit = raw.unit !== undefined ? normalizeIntentUnit(raw.unit) : undefined;
    const splits = splitQuantitySegments(raw.productName, {
      segHasContainerUnit: rawUnit === ProductUnit.PACK || rawUnit === ProductUnit.UNIT,
      insidePriceSpan: (index) => spans.some((s) => index >= s.start && index < s.end),
      isUnitWord: (word) => normalizeIntentUnit(word) !== null,
    });
    if (splits.length <= 1 || out.length + splits.length > MAX_INTENT_ITEMS) {
      out.push(raw);
      continue;
    }
    splits.forEach((piece, pieceIndex) => {
      if (pieceIndex === 0) {
        out.push({ ...raw, productName: piece.text });
      } else {
        out.push({
          productName: piece.text,
          quantity: piece.quantity,
          ...(piece.unit !== undefined ? { unit: piece.unit } : {}),
        });
      }
    });
  }
  return out;
}

function sanitizeOpenWorldName(proposed: string): string | null {
  const collapsed = proposed.trim().replace(/\s+/g, ' ');
  if (collapsed.length === 0 || collapsed.length > MAX_PRODUCT_NAME_LENGTH) return null;
  if (!/\p{L}/u.test(collapsed)) return null;
  return collapsed;
}

function mapZodIssues(error: ZodError): IntentIssue[] {
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
        message: `Model output contains unauthorized field(s) at ${path || 'root'}: ${issue.keys.join(', ')}`,
        itemIndex,
      };
    }
    return {
      code: 'SCHEMA_VIOLATION',
      message: `Model output failed validation at ${path || 'root'}: ${issue.message}`,
      itemIndex,
    };
  });
}

/**
 * Phase 14.2 — deterministic intent extraction service.
 *
 * Flow: user request → model proposes structured intent via ONE inference-only
 * tool call → deterministic zod validation → deterministic unit/catalog
 * resolution → validated Relay intent. Nothing here mutates procurement,
 * payment, allocation, or workflow state.
 */
export class IntentExtractor {
  private provider: ModelProvider;

  constructor(options?: { provider?: ModelProvider }) {
    this.provider = options?.provider ?? getModelProvider();
  }

  public async extract(userRequest: string): Promise<IntentExtractionResult> {
    if (!userRequest || userRequest.trim().length === 0) {
      return {
        status: 'invalid',
        issues: [{ code: 'EMPTY_REQUEST', message: 'Request text cannot be empty.' }],
      };
    }
    if (userRequest.length > MAX_REQUEST_CHARS) {
      return {
        status: 'invalid',
        issues: [
          {
            code: 'REQUEST_TOO_LARGE',
            message: `Request exceeds maximum length of ${MAX_REQUEST_CHARS} characters.`,
          },
        ],
      };
    }
    let normalizedRequest = normalizeDevanagariNumerals(userRequest);
    normalizedRequest = normalizeIndicNumberWords(normalizedRequest);

    if (detectAmbiguousQuantityPhrasing(normalizedRequest)) {
      return {
        status: 'unresolved',
        issues: [
          {
            code: 'AMBIGUOUS_QUANTITY',
            message:
              'Request contains approximate or conditional quantities. ' +
              'Please specify the exact fixed quantity you want procured.',
          },
        ],
      };
    }

    if (detectContradictoryDeliveryPhrasing(normalizedRequest)) {
      return {
        status: 'unresolved',
        issues: [
          {
            code: 'CONTRADICTORY_SCHEDULE',
            message:
              'Request contains conflicting delivery schedule requirements. ' +
              'Please clarify whether you require urgent immediate delivery or a later scheduled date.',
          },
        ],
      };
    }

    if (detectIdentityOverrideInstruction(normalizedRequest)) {
      return {
        status: 'invalid',
        issues: [
          {
            code: 'PROMPT_INJECTION_DETECTED',
            message:
              'Request refused: it contains instructions attempting to override product identity. ' +
              'Please restate the procurement need plainly with product, quantity, and unit.',
          },
        ],
      };
    }
    if (detectNegativeQuantity(normalizedRequest)) {
      // Pre-model tripwire: negative quantities are never procurable, and a
      // model that silently drops the minus sign would fabricate a quantity.
      // Reject deterministically before any model call.
      return {
        status: 'invalid',
        issues: [
          {
            code: 'NEGATIVE_QUANTITY',
            message:
              'Request refused: quantities must be positive. ' +
              'Please restate the procurement need with a positive quantity.',
          },
        ],
      };
    }

    let response;
    try {
      response = await this.provider.generateWithTools({
        messages: [
          { role: 'system', content: INTENT_EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: normalizedRequest },
        ],
        tools: [EXTRACT_INTENT_TOOL],
        temperature: 0.1,
        maxTokens: 4096,
        reasoningEffort: 'low',
      });
    } catch (err) {
      if (err instanceof ModelProviderError) {
        return {
          status: 'error',
          issues: [{ code: err.code, message: err.message }],
        };
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

    let extractCalls = (response.toolCalls ?? []).filter((c) => c.name === INTENT_TOOL_NAME);
    if (extractCalls.length === 0) {
      const rawCode = (response.raw as { code?: unknown } | undefined)?.code;
      if (typeof rawCode === 'string' && rawCode === 'UNMAPPABLE_PRODUCT') {
        return {
          status: 'unresolved',
          issues: [
            {
              code: 'UNMAPPABLE_PRODUCT',
              message:
                response.content ||
                'I need a little more information — I understood you want something procured, ' +
                  'but I could not identify the exact product or quantity yet. ' +
                  'Please restate the request with product, quantity, and unit.',
            },
          ],
        };
      }
      // Bounded repair for a prose-only response: retry the SAME request once
      // and require function-only output. No new facts are introduced; if the
      // retry still has no tool call, fail closed as before.
      try {
        response = await this.provider.generateWithTools({
          messages: [
            { role: 'system', content: INTENT_EXTRACTION_SYSTEM_PROMPT },
            { role: 'user', content: userRequest },
            {
              role: 'user',
              content:
                'Return ONLY the extract_procurement_intent function call for the request above. ' +
                'Include one item per product with its stated quantity and unit — a stated count with a stated ' +
                'commercial unit (pack, packet, bottle, carton, unit, kg, gram, litre, ml) is complete, and a ' +
                'missing pack size is not ambiguity. Do not write prose.',
            },
          ],
          tools: [EXTRACT_INTENT_TOOL],
          temperature: 0.1,
          maxTokens: 4096,
          reasoningEffort: 'low',
        });
      } catch (err) {
        if (err instanceof ModelProviderError) {
          return {
            status: 'error',
            issues: [{ code: err.code, message: err.message }],
          };
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
      extractCalls = (response.toolCalls ?? []).filter((c) => c.name === INTENT_TOOL_NAME);
      if (extractCalls.length === 0) {
        return {
          status: 'invalid',
          issues: [
            {
              code: 'NO_TOOL_CALL',
              message: 'Model did not return a structured intent tool call.',
            },
          ],
        };
      }
    }
    if (extractCalls.length > 1) {
      return {
        status: 'invalid',
        issues: [
          {
            code: 'MULTIPLE_TOOL_CALLS',
            message: 'Model returned more than one intent tool call.',
          },
        ],
      };
    }

    const parsed = rawIntentSchema.safeParse(stripExplicitNulls(extractCalls[0].arguments));
    if (!parsed.success) {
      return { status: 'invalid', issues: mapZodIssues(parsed.error) };
    }

    const items: ValidatedIntentItem[] = [];
    const issues: IntentIssue[] = [];
    repairBlobItems(parsed.data.items).forEach((raw, index) => {
      const item: ValidatedIntentItem = {
        productName: raw.productName.trim(),
        brand: raw.brand?.trim() || undefined,
        packaging: raw.packaging?.trim() || undefined,
        packSize: raw.packSize?.trim() || undefined,
        priceCue: raw.priceCue?.trim() || undefined,
        variant: raw.variant?.trim() || undefined,
        constraints: raw.constraints ?? [],
        preferences: raw.preferences,
        notes: raw.notes,
        resolution: { status: 'unresolved', reason: 'UNMAPPABLE_PRODUCT' },
      };

      if (isReferentiallyAmbiguous(item.productName)) {
        item.resolution = { status: 'unresolved', reason: 'AMBIGUOUS_REFERENCE' };
        issues.push({
          code: 'AMBIGUOUS_REFERENCE',
          message: `Item ${index} ("${item.productName}") does not name a product — it only refers to one. Ask which product is meant.`,
          itemIndex: index,
        });
        items.push(item);
        return;
      }

      if (raw.quantity === undefined) {
        item.resolution = { status: 'unresolved', reason: 'MISSING_QUANTITY' };
        issues.push({
          code: 'MISSING_QUANTITY',
          message: `Item ${index} ("${item.productName}") has no stated quantity.`,
          itemIndex: index,
        });
        items.push(item);
        return;
      }
      item.quantity = raw.quantity;

      // Unit-from-packaging completion: a stated container word filed only
      // under packaging ("2 jars honey" → packaging jar, unit omitted) is
      // still a stated commercial unit per the completeness rule. Filing it
      // as the unit is normalization, not invention — the word came from
      // the user, and only Relay-representable words qualify.
      const statedUnit =
        raw.unit ?? (raw.packaging && normalizeIntentUnit(raw.packaging) ? raw.packaging : undefined);

      if (statedUnit === undefined) {
        // Deterministic count-noun rule (mirrors WorkflowPlanner count+product
        // handling): an explicit count of a catalog product whose authoritative
        // unit is UNIT unambiguously means that many units. All other
        // unit-less items stay unresolved — Relay never guesses kg vs packs.
        const countMatch = matchCatalogProduct(item.productName, item.brand);
        if (countMatch && countMatch.unit === ProductUnit.UNIT) {
          item.unit = ProductUnit.UNIT;
          item.resolution = {
            status: 'resolved',
            productId: countMatch.productId,
            canonicalName: countMatch.canonicalName,
            identitySource: 'catalog',
          };
          items.push(item);
          return;
        }
        item.resolution = { status: 'unresolved', reason: 'MISSING_UNIT' };
        issues.push({
          code: 'MISSING_UNIT',
          message: `Item ${index} ("${item.productName}") has no stated unit.`,
          itemIndex: index,
        });
        items.push(item);
        return;
      }
      // Exact dozen conversion (Relay arithmetic: a dozen is precisely 12).
      if (isDozenUnitWord(statedUnit)) {
        const converted = toDecimal(raw.quantity).times(12).toNumber();
        if (!Number.isFinite(converted) || converted > MAX_QUANTITY) {
          issues.push({
            code: 'QUANTITY_OUT_OF_RANGE',
            message: `Item ${index} ("${item.productName}") quantity exceeds the maximum after dozen conversion.`,
            itemIndex: index,
          });
          items.push(item);
          return;
        }
        item.quantity = converted;
        item.unit = ProductUnit.UNIT;
        item.rawUnit = statedUnit;
      } else {
        const unit = normalizeIntentUnit(statedUnit);
        if (!unit) {
          issues.push({
            code: 'UNSUPPORTED_UNIT',
            message: `Item ${index} ("${item.productName}") uses unsupported unit "${statedUnit}".`,
            itemIndex: index,
          });
          items.push(item);
          return;
        }
        item.unit = unit;
        item.rawUnit = statedUnit;
        // Deterministic packaging backstop: when the stated unit word IS a
        // container (bottles, strips, ...) but the model omitted packaging,
        // file the stated word rather than depending on model whims.
        if (unit === ProductUnit.PACK && item.packaging === undefined) {
          const singular = singularizeContainerWord(statedUnit);
          if (singular !== 'pack' && singular !== 'packet') {
            item.packaging = singular;
          }
        }
      }

      const match = matchCatalogProduct(item.productName, item.brand);
      if (match) {
        item.resolution = {
          status: 'resolved',
          productId: match.productId,
          canonicalName: match.canonicalName,
          identitySource: 'catalog',
        };
        items.push(item);
        return;
      }
      // Open-world product: the catalog is a normalization layer, not a
      // whitelist. A structurally valid item (sanitized name + validated
      // quantity/unit) proceeds with Meta-understood identity and NO
      // authoritative product ID. Only a meaningless name fails closed.
      const openName = sanitizeOpenWorldName(item.productName);
      if (!openName) {
        item.resolution = { status: 'unresolved', reason: 'UNMAPPABLE_PRODUCT' };
        issues.push({
          code: 'UNMAPPABLE_PRODUCT',
          message:
            `Item ${index} could not be identified as a procurable product. ` +
            'I need a little more information — please restate the request with product, quantity, and unit.',
          itemIndex: index,
        });
        items.push(item);
        return;
      }
      item.productName = openName;
      item.resolution = {
        status: 'resolved',
        productId: null,
        canonicalName: openName,
        identitySource: 'open-world',
      };
      items.push(item);
    });

    if (issues.some((i) => i.code === 'UNSUPPORTED_UNIT')) {
      return { status: 'invalid', issues };
    }

    const intent: ValidatedIntent = {
      originalRequest: userRequest,
      items,
      deadline: parsed.data.deadline,
      payment: parsed.data.payment,
    };
    return issues.length === 0
      ? { status: 'ok', intent, issues }
      : { status: 'unresolved', intent, issues };
  }
}

/**
 * Canonical-unit mapping to the lowercase unit convention used by the
 * orchestration-layer ParsedResidentIntent.
 */
const UNIT_TO_PLANNER: Record<ProductUnit, string> = {
  [ProductUnit.KG]: 'kg',
  [ProductUnit.GRAM]: 'grams',
  [ProductUnit.LITRE]: 'liters',
  [ProductUnit.ML]: 'ml',
  [ProductUnit.PACK]: 'packs',
  [ProductUnit.UNIT]: 'units',
};

/**
 * Converts a validated multi-item intent into one ParsedResidentIntent per
 * RESOLVED item for downstream deterministic consumption. Unresolved items
 * are never converted — fail closed.
 */
export function toParsedResidentIntents(intent: ValidatedIntent): ParsedResidentIntent[] {
  return intent.items
    .filter(
      (
        item
      ): item is ValidatedIntentItem & {
        quantity: number;
        unit: ProductUnit;
        resolution: {
          status: 'resolved';
          productId: string | null;
          canonicalName: string;
          identitySource: 'catalog' | 'open-world';
        };
      } =>
        item.resolution.status === 'resolved' &&
        item.quantity !== undefined &&
        item.unit !== undefined
    )
    .map((item) => ({
      rawText: intent.originalRequest,
      productName: item.resolution.canonicalName,
      quantity: item.quantity,
      unit: UNIT_TO_PLANNER[item.unit],
      ...(item.brand !== undefined ? { brand: item.brand } : {}),
      ...(item.packaging !== undefined ? { packaging: item.packaging } : {}),
      ...(item.packSize !== undefined ? { packSize: item.packSize } : {}),
      ...(item.priceCue !== undefined ? { priceCue: item.priceCue } : {}),
      ...(item.variant !== undefined ? { variant: item.variant } : {}),
      constraints: item.constraints.length > 0 ? item.constraints : undefined,
      isAmbiguous: false,
    }));
}
