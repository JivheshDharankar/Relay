import { ProductUnit } from '@prisma/client';
import { ModelProvider } from './ModelProvider';
import { ModelRequest, ToolModelRequest, ModelResponse, ToolCall } from './types';
import { SEED_IDS } from '../../config/seedConstants';
import { INTENT_TOOL_NAME, normalizeIntentUnit, singularizeContainerWord } from '../intent/intentSchema';
import {
  BARE_PRICE_MARKER_RE,
  PRICE_CUE_RE,
  findNextSegmentQty,
  findPriceSpans,
} from '../intent/quantitySegments';
import { matchCatalogProduct } from '../intent/catalogMatcher';
import { DISCOVERY_TOOL_NAME } from '../discovery/discoverySchema';
import { QUOTE_TOOL_NAME } from '../quote/quoteSchema';
import { NEGOTIATION_TOOL_NAME } from '../negotiation/negotiationSchema';
import { ORCHESTRATION_TOOL_NAME } from '../orchestration/orchestrationSchema';

export interface ScriptedStep {
  toolCall?: ToolCall;
  content?: string;
}

interface IntentMatch {
  productId: string;
  quantity: number;
  unit: 'KG' | 'LITRE' | 'GRAM' | 'ML' | 'PACK' | 'UNIT';
  productName: string;
}

/**
 * Temporary pre-Spark deterministic intent parser for validating generic frontend data flows.
 * Supports catalog items: Rice, Wheat, Cooking Oil, Detergent, Cleaning Liquid.
 * Flags unsupported items (e.g. Sugar) cleanly without faking AI.
 */
/**
 * Generic honesty check: finds quantity-led segments ("3 icecream",
 * "500 g ginger") whose product phrase matches NO catalog entry. Uses the
 * deterministic catalog matcher — no product-specific logic. Lets the mock
 * fail closed on mixed mappable+unmappable requests exactly like the real
 * model path (which emits every item, leaving unknowns unresolved).
 */
const QUANTITY_SEGMENT_RE =
  /(\d+(?:\.\d+)?)\s*(kg|kilos?|kilograms?|grams?|gms?|g|litres?|liters?|l|ml|packs?|units?|pieces?)?\s*(?:of\s+)?([a-z][a-z\s]{0,28}?)(?=\s*(?:,|\+|\band\b|\bwithin\b|\bfor\b|\bwith\b|\.|$))/gi;
const TIME_WORDS = new Set(['hour', 'hours', 'hr', 'hrs', 'day', 'days', 'minute', 'minutes']);

function depluralize(phrase: string): string {
  return phrase
    .split(/\s+/)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

function findUnmappedSegment(text: string): string | null {
  QUANTITY_SEGMENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUANTITY_SEGMENT_RE.exec(text)) !== null) {
    // Skip monetary amounts ("₹5000 budget") — not product segments.
    if (m.index > 0 && text[m.index - 1] === '₹') continue;
    const phrase = m[3].trim().replace(/\s+/g, ' ');
    // Time budgets ("12 hours", "12 hours under community mandate") are
    // deadlines, not products — skipped by leading time word.
    if (!phrase || TIME_WORDS.has(phrase.split(' ')[0])) continue;
    if (matchCatalogProduct(phrase) || matchCatalogProduct(depluralize(phrase))) continue;
    const excerpt = `${m[1]}${m[2] ? ` ${m[2]}` : ''} ${phrase}`;
    return excerpt;
  }
  return null;
}

/**
 * Generic open-world segment parsing for the 14.2 extraction tool path.
 *
 * Deliberately product-agnostic: it recognizes quantity-led SEGMENTS
 * (count + optional unit word + product phrase) plus generic grammatical
 * constructions (price cues, counted priced ones, pack sizes, deadlines).
 * It contains NO product, brand, or language-specific product vocabulary —
 * catalog matching happens downstream in the deterministic extractor, and
 * real language understanding comes from the live model. Unknown products
 * are emitted as stated so the extractor can preserve them as open-world
 * items; genuinely missing facts surface as targeted clarification issues.
 */
const SEGMENT_UNIT_WORDS =
  'kg|kilos?|kilograms?|grams?|gms?|g|litres?|liters?|l|mls?|packs?|packets?|bottles?|jars?|cans?|boxes?|box|cartons?|dozens?|dz|tins?|pouches?|sachets?|bags?|crates?|rolls?|tubes?|strips?|units?|pieces?|pcs?|each|bars?|tetra[-\\s]?packs?|tetrapacks?|cups?|glasses?';

const SEGMENT_BOUNDARY_RE = /,|\+|;|\.|\band\b|\baur\b|&|\bwithin\b|\bfor\b|\bwith\b/i;

const PRICED_ONES_MARKER_RE = /\b(wale|wali|wale|ke|ki|ka)\b/i;
const PACK_SIZE_LEAD_RE = /^(\d+(?:\.\d+)?)\s*(ml|g|kg|l|litres?|liters?|grams?)\b/i;
const QTY_RE = /\d+(?:\.\d+)?/g;

const NON_PRODUCT_LEAD_WORDS = new Set([
  'budget',
  'total',
  'limit',
  'mandate',
  'mandates',
  'rupees',
  'rs',
  'inr',
]);

interface GenericSegment {
  productName: string;
  quantity?: number;
  unit?: string;
  packaging?: string;
  packSize?: string;
  priceCue?: string;
}



function cutAtBoundary(text: string): { head: string; boundary: string | null } {
  const m = SEGMENT_BOUNDARY_RE.exec(text);
  if (!m || m.index === undefined) return { head: text, boundary: null };
  return { head: text.slice(0, m.index), boundary: m[0] };
}

function cleanPhrase(raw: string): string {
  return raw
    .replace(/₹/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSkippablePhrase(phrase: string): boolean {
  if (!phrase) return true;
  const first = phrase.split(' ')[0].toLowerCase();
  return TIME_WORDS.has(first) || NON_PRODUCT_LEAD_WORDS.has(first);
}

/**
 * Emits one generic segment per quantity-led span, in mention order, plus
 * bare product phrases after item boundaries (which honestly surface as
 * MISSING_QUANTITY downstream instead of being silently dropped).
 */
function parseGenericSegments(text: string): GenericSegment[] {
  const segments: GenericSegment[] = [];

  // Price spans are commercial cues, never quantities (e.g. "10 rs wale").
  const priceSpans = findPriceSpans(text);
  const insidePriceSpan = (index: number): boolean =>
    priceSpans.some((s) => index >= s.start && index < s.end);

  const unitAfterQtyRe = new RegExp(`^\\s*(${SEGMENT_UNIT_WORDS})\\b`, 'i');
  const trailingUnitRe = new RegExp(`^(.*?)\\s+(${SEGMENT_UNIT_WORDS})$`, 'i');

  QTY_RE.lastIndex = 0;
  let qm: RegExpExecArray | null;
  let cursor = 0;
  while ((qm = QTY_RE.exec(text)) !== null) {
    if (qm.index < cursor) continue;
    if (insidePriceSpan(qm.index)) continue;
    if (qm.index > 0 && text[qm.index - 1] === '₹') continue;
    const quantity = parseFloat(qm[0]);
    let rest = text.slice(qm.index + qm[0].length);

    let unit: string | undefined;
    const unitMatch = unitAfterQtyRe.exec(rest);
    if (unitMatch) {
      unit = unitMatch[1];
      rest = rest.slice(unitMatch[0].length);
    }
    rest = rest.replace(/^\s*of\s+/i, '');
    let { head, boundary } = cutAtBoundary(rest);
    const absStart = text.length - rest.length;
    const canonicalUnit = unit !== undefined ? normalizeIntentUnit(unit) : undefined;
    const qtyCut = findNextSegmentQty(
      text,
      absStart,
      absStart + head.length,
      insidePriceSpan,
      canonicalUnit === ProductUnit.PACK || canonicalUnit === ProductUnit.UNIT
    );
    if (qtyCut !== -1) {
      // A fresh quantity starts the next span: the boundary word (if any)
      // lies beyond the cut and is not consumed by this segment.
      head = text.slice(absStart, qtyCut);
      boundary = null;
    }
    cursor = absStart + head.length;

    let headText = head;
    let priceCue: string | undefined;
    // Marker check runs on the original head: bare cues ("20 ke") carry the
    // marker inside the cue itself.
    const hasPricedOnesMarker = PRICED_ONES_MARKER_RE.test(headText);
    const cueInHead =
      headText.match(new RegExp(PRICE_CUE_RE.source, 'i')) ??
      headText.match(new RegExp(BARE_PRICE_MARKER_RE.source, 'i'));
    if (cueInHead) {
      const amount = cueInHead[1] ?? cueInHead[2] ?? cueInHead[0].match(/\d+(?:\.\d+)?/)?.[0];
      if (amount) priceCue = `₹${amount}`;
      headText = headText.replace(cueInHead[0], ' ');
    }
    headText = headText.replace(new RegExp(PRICED_ONES_MARKER_RE.source, 'gi'), ' ');

    let packSize: string | undefined;
    const packMatch = PACK_SIZE_LEAD_RE.exec(headText.trim());
    if (packMatch) {
      packSize = packMatch[0].trim().replace(/\s+/g, '');
      headText = headText.trim().slice(packMatch[0].length);
    }

    let phrase = cleanPhrase(headText.replace(/^\s*of\s+/i, ''));
    if (!unit && phrase) {
      // Container-after-product order (quantity, then product, then container word).
      const trailing = trailingUnitRe.exec(phrase);
      if (trailing && trailing[1].trim()) {
        unit = trailing[2];
        phrase = trailing[1].trim();
      }
    }
    if (!phrase) {
      // Product-before-quantity order ("sugar 2 kg"): scan back over
      // letter words up to the previous boundary. Request verbs are never
      // products ("I need 5" must not emit "I need").
      const before = text.slice(0, qm.index);
      const words = before.match(/[a-zA-Z]+/g) ?? [];
      phrase = words
        .slice(-4)
        .join(' ')
        .replace(/^(i\s+need|need|want|get|buy|order|please)\b/i, '')
        .trim();
    }
    if (!phrase || isSkippablePhrase(phrase.toLowerCase())) continue;
    if (phrase.length > 120) continue;

    if (!unit && priceCue && hasPricedOnesMarker) {
      // Counted priced ones (e.g. "2 noodles 10 rs wale"): the count noun is the
      // pack. Size stays unknown — never invented.
      unit = 'pack';
    }

    const segment: GenericSegment = { productName: phrase, quantity };
    if (unit) {
      segment.unit = unit;
      const canonical = normalizeIntentUnit(unit);
      if (canonical === ProductUnit.PACK) {
        const singular = singularizeContainerWord(unit);
        if (singular !== 'pack' && singular !== 'packet') {
          segment.packaging = singular;
        }
      }
    }
    if (packSize) segment.packSize = packSize;
    if (priceCue) segment.priceCue = priceCue;
    segments.push(segment);

    // Bare product phrase after an item boundary ("rice and wheat"):
    // emit without quantity so it clarifies honestly instead of vanishing.
    if (boundary && /^(and|aur|,|\+|&)$/i.test(boundary.trim())) {
      const after = text.slice(cursor + boundary.length);
      const nextQty = after.search(/\d/);
      const tailProbe = nextQty === -1 ? after : after.slice(0, nextQty);
      const { head: bareHead } = cutAtBoundary(tailProbe);
      const bare = cleanPhrase(bareHead.replace(/^\s*of\s+/i, ''));
      if (
        bare &&
        !isSkippablePhrase(bare.toLowerCase()) &&
        bare.length <= 120 &&
        !PRICE_CUE_RE.test(bare) &&
        !/^(i\s+need|need|want|get|buy|order|please)\b/i.test(bare)
      ) {
        segments.push({ productName: bare });
      }
    }
  }
  return segments;
}

function parseUserIntent(prompt: string): { matches: IntentMatch[]; unsupportedItem?: string } {
  const text = prompt.toLowerCase();

  const matches: IntentMatch[] = [];

  // 1. Rice match (skipped when Ambemohar is present — branch 14 owns it)
  if (
    (text.includes('rice') || text.includes('basmati') || text.includes('chawal')) &&
    !text.includes('ambemohar') &&
    !text.includes('ambemohor')
  ) {
    const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?|packs?|units?)?\s*(?:of\s+)?(?:basmati\s+)?rice/i) ||
                     text.match(/rice[^\d]*(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)?/i) ||
                     text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)/i);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 10.0;
    matches.push({
      productId: SEED_IDS.products.rice,
      quantity: qty,
      unit: 'KG',
      productName: 'Basmati Rice (Extra Long Grain)',
    });
  }

  // 2. Wheat match
  if (text.includes('wheat') || text.includes('atta') || text.includes('flour') || text.includes('sharbati')) {
    const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?|packs?|units?)?\s*(?:of\s+)?(?:sharbati\s+)?(?:whole\s+)?(?:wheat|atta)/i) ||
                     text.match(/(?:wheat|atta)[^\d]*(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)?/i) ||
                     text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)/i);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 20.0;
    matches.push({
      productId: SEED_IDS.products.wheat,
      quantity: qty,
      unit: 'KG',
      productName: 'Sharbati Whole Wheat Atta',
    });
  }

  // 3. Oil match
  if (/\boil\b/i.test(text) || /\bsunflower\b/i.test(text) || /\btel\b/i.test(text)) {
    const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:l|litres?|liters?)?\s*(?:of\s+)?(?:sunflower\s+)?(?:cooking\s+)?oil/i) ||
                     text.match(/oil[^\d]*(\d+(?:\.\d+)?)\s*(?:l|litres?|liters?)?/i) ||
                     text.match(/(\d+(?:\.\d+)?)\s*(?:l|litres?|liters?)/i);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 5.0;
    matches.push({
      productId: SEED_IDS.products.cookingOil,
      quantity: qty,
      unit: 'LITRE',
      productName: 'Cold-Pressed Sunflower Cooking Oil',
    });
  }

  // 4. Detergent match
  if (text.includes('detergent') || text.includes('washing powder') || text.includes('laundry')) {
    const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?|packs?|units?)?\s*(?:of\s+)?(?:eco\s+)?(?:clean\s+)?(?:laundry\s+)?(?:detergent|washing powder)/i) ||
                     text.match(/(?:detergent|washing powder|laundry)[^\d]*(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)?/i) ||
                     text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)/i);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 5.0;
    matches.push({
      productId: SEED_IDS.products.detergent,
      quantity: qty,
      unit: 'KG',
      productName: 'Eco Clean Laundry Detergent Powder',
    });
  }

  // 5. Sugar match
  if (text.includes('sugar') || text.includes('cheeni') || text.includes('sakhar')) {
    const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?|packs?|units?)?\s*(?:of\s+)?(?:organic\s+)?(?:refined\s+)?(?:cane\s+)?(?:sugar|cheeni|sakhar)/i) ||
                     text.match(/(?:sugar|cheeni|sakhar)[^\d]*(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)?/i) ||
                     text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)/i);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 2.0;
    matches.push({
      productId: SEED_IDS.products.sugar,
      quantity: qty,
      unit: 'KG',
      productName: 'Organic Refined Cane Sugar',
    });
  }

  // 6. Groundnut match
  if (text.includes('groundnut') || text.includes('peanut') || text.includes('moongphali') || text.includes('shengdana')) {
    const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?|packs?|units?)?\s*(?:of\s+)?(?:raw\s+)?(?:premium\s+)?(?:groundnut|peanut|moongphali|shengdana)/i) ||
                     text.match(/(?:groundnut|peanut|moongphali|shengdana)[^\d]*(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)?/i) ||
                     text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)/i);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 2.0;
    matches.push({
      productId: SEED_IDS.products.groundnut,
      quantity: qty,
      unit: 'KG',
      productName: 'Raw Premium Groundnut (Peanuts)',
    });
  }

  // 7. Toothbrush match
  if (text.includes('toothbrush') || text.includes('toothbrushes') || text.includes('brush')) {
    const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:units?|packs?|pieces?|toothbrushes?|brushes?)?\s*(?:of\s+)?(?:soft\s+)?(?:bristle\s+)?(?:bamboo\s+)?(?:toothbrush|toothbrushes|brush)/i) ||
                     text.match(/(?:toothbrush|toothbrushes|brush)[^\d]*(\d+(?:\.\d+)?)/i) ||
                     text.match(/(\d+(?:\.\d+)?)\s*(?:units?|packs?|pieces?|toothbrushes?)?/i);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 2.0;
    matches.push({
      productId: SEED_IDS.products.toothbrushes,
      quantity: qty,
      unit: 'UNIT',
      productName: 'Soft Bristle Bamboo Toothbrushes (Pack of 2)',
    });
  }

  // 8. Banana match (count-based fresh produce; word boundaries avoid 'plantain'-style collisions)
  if (/\bbananas?\b/i.test(text) || /\bkela\b/i.test(text)) {
    const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:units?|pieces?|dozen)?\s*(?:of\s+)?(?:fresh\s+)?(?:robusta\s+)?(?:banana|bananas|kela)/i) ||
                     text.match(/(?:banana|bananas|kela)[^\d]*(\d+(?:\.\d+)?)/i);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 6;
    matches.push({
      productId: SEED_IDS.products.bananas,
      quantity: qty,
      unit: 'UNIT',
      productName: 'Fresh Robusta Bananas',
    });
  }

  // 9. Orange match (count-based fresh produce)
  if (/\boranges?\b/i.test(text) || /\bsantra\b/i.test(text)) {
    const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:units?|pieces?|dozen)?\s*(?:of\s+)?(?:nagpur\s+)?(?:mandarin\s+)?(?:orange|oranges|santra)/i) ||
                     text.match(/(?:orange|oranges|santra)[^\d]*(\d+(?:\.\d+)?)/i);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 12;
    matches.push({
      productId: SEED_IDS.products.oranges,
      quantity: qty,
      unit: 'UNIT',
      productName: 'Nagpur Mandarin Oranges',
    });
  }

  // 10. Apple match (weight-based fresh produce)
  if (/\bapples?\b/i.test(text) || /\bseb\b/i.test(text)) {
    const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?|units?|pieces?)?\s*(?:of\s+)?(?:kashmiri\s+)?(?:red\s+)?(?:apple|apples|seb)/i) ||
                     text.match(/(?:apple|apples|seb)[^\d]*(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)?/i);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 1.0;
    matches.push({
      productId: SEED_IDS.products.apple,
      quantity: qty,
      unit: 'KG',
      productName: 'Kashmiri Red Apples',
    });
  }

  // 11. Bajra match (weight-based millet)
  if (/\bbajra\b/i.test(text) || /\bpearl\s+millet\b/i.test(text)) {
    const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)?\s*(?:of\s+)?(?:pearl\s+millet\s+)?bajra/i) ||
                     text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)?\s*(?:of\s+)?pearl\s+millet/i) ||
                     text.match(/(?:bajra|pearl\s+millet)[^\d]*(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)?/i);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 2.0;
    matches.push({
      productId: SEED_IDS.products.bajra,
      quantity: qty,
      unit: 'KG',
      productName: 'Pearl Millet Bajra Grain',
    });
  }

  // 12. Dark chocolate match (weight-based confectionery)
  if (/\bdark\s+chocolate\b/i.test(text) || /\bchocolate\b/i.test(text)) {
    const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)?\s*(?:of\s+)?(?:dark\s+)?(?:baking\s+)?chocolate/i) ||
                     text.match(/(?:dark\s+)?chocolate[^\d]*(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)?/i);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 2.0;
    matches.push({
      productId: SEED_IDS.products.darkChocolate,
      quantity: qty,
      unit: 'KG',
      productName: 'Dark Chocolate Baking Bar 70%',
    });
  }

  // 13. Maida match (weight-based flour)
  if (/\bmaida\b/i.test(text)) {
    const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)?\s*(?:of\s+)?maida/i) ||
                     text.match(/maida[^\d]*(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)?/i);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 2.0;
    matches.push({
      productId: SEED_IDS.products.maida,
      quantity: qty,
      unit: 'KG',
      productName: 'Refined Wheat Flour (Maida)',
    });
  }

  // 14. Ambemohar rice match (weight-based aromatic rice; branch 1 yields to it)
  if (/\bambemohar\b/i.test(text) || /\bambemohor\b/i.test(text)) {
    const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)?\s*(?:of\s+)?ambemohar(?:\s+rice)?/i) ||
                     text.match(/ambemohar[^\d]*(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)?/i);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 25.0;
    matches.push({
      productId: SEED_IDS.products.ambemoharRice,
      quantity: qty,
      unit: 'KG',
      productName: 'Ambemohar Aromatic Rice',
    });
  }

  // No keyword matched: the request is unmappable. NEVER substitute a
  // default product — return the original command for an honest stop.
  if (matches.length === 0) {
    const excerpt = prompt.trim().replace(/\s+/g, ' ').slice(0, 120);
    return { matches, unsupportedItem: excerpt.length > 0 ? excerpt : 'this request' };
  }

  // Mixed request honesty: known products matched, but an unconsumed
  // quantity-led segment names something outside the catalog. Fail the
  // WHOLE request closed — never silently procure only the known part.
  const unmapped = findUnmappedSegment(text);
  if (unmapped) {
    return { matches, unsupportedItem: unmapped };
  }

  return { matches };
}

/**
 * Phase 14.2 deterministic deadline parsing for intent-extraction mode.
 * Returns maxHours only when the user explicitly stated a time limit.
 */
function parseDeadlineHours(text: string): number | undefined {
  const hourMatch = text.match(/within\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?)\b/i);
  if (hourMatch) return parseFloat(hourMatch[1]);
  const dayMatch = text.match(/within\s+(\d+(?:\.\d+)?)\s*days?\b/i);
  if (dayMatch) return parseFloat(dayMatch[1]) * 24;
  return undefined;
}

function findRecordedOrderItem(
  messages: Array<{ role: string; name?: string; content: string }>
): { quantity: number; unit: string; productName: string } | null {
  for (const m of messages) {
    if (m.role !== 'tool' || m.name !== 'createRequest') continue;
    try {
      const r = JSON.parse(m.content || '{}') as Record<string, unknown>;
      if (
        typeof r.productName === 'string' &&
        r.productName.length > 0 &&
        typeof r.quantity === 'number' &&
        typeof r.unit === 'string'
      ) {
        return { quantity: r.quantity, unit: r.unit, productName: r.productName };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export class MockModelProvider implements ModelProvider {
  public readonly providerName = 'mock';
  private scriptedSequence: ScriptedStep[] = [];
  private currentStepIndex = 0;
  private lastCreatedOrderId?: string;
  private lastCommunityOrderId?: string;
  private activeIntent?: IntentMatch;
  private lastRequestedPrice?: number;

  constructor(customSequence?: ScriptedStep[]) {
    if (customSequence) {
      this.scriptedSequence = customSequence;
    }
  }

  /**
   * Sets a custom scripted sequence for testing specific agent failure or recovery cases.
   */
  public setSequence(steps: ScriptedStep[]): void {
    this.scriptedSequence = steps;
    this.currentStepIndex = 0;
  }

  public reset(): void {
    this.currentStepIndex = 0;
    this.lastCreatedOrderId = undefined;
    this.lastCommunityOrderId = undefined;
    this.activeIntent = undefined;
    this.lastRequestedPrice = undefined;
  }

  public async generate(_request: ModelRequest): Promise<ModelResponse> {
    return {
      content: 'Mock Model Text Response',
      finishReason: 'stop',
    };
  }

  private extractIntentDeterministic(request: ToolModelRequest): ModelResponse {
    const userMessage = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user');
    const text = userMessage?.content || '';
    const segments = parseGenericSegments(text);

    if (segments.length === 0) {
      return {
        content:
          'I need a little more information — I understood you want something procured, ' +
          'but I could not identify the exact product or quantity yet. ' +
          'Please restate the request with product, quantity, and unit.',
        finishReason: 'stop',
        raw: { code: 'UNMAPPABLE_PRODUCT' },
      };
    }

    const items = segments.map((s) => {
      const item: Record<string, unknown> = { productName: s.productName };
      if (s.quantity !== undefined) item.quantity = s.quantity;
      if (s.unit !== undefined) item.unit = s.unit;
      if (s.packaging !== undefined) item.packaging = s.packaging;
      if (s.packSize !== undefined) item.packSize = s.packSize;
      if (s.priceCue !== undefined) item.priceCue = s.priceCue;
      return item;
    });
    const args: Record<string, unknown> = { items };
    const deadline = parseDeadlineHours(text);
    if (deadline !== undefined) {
      args.deadline = { maxHours: deadline };
    }
    if (/community\s+mandate/i.test(text)) {
      args.payment = { mandateType: 'community' };
    } else if (/personal\s+mandate/i.test(text)) {
      args.payment = { mandateType: 'personal' };
    }

    return {
      content: '',
      toolCalls: [
        {
          id: 'call_extract_01',
          name: INTENT_TOOL_NAME,
          arguments: args,
        },
      ],
      finishReason: 'tool_calls',
    };
  }

  private planDiscoveryDeterministic(request: ToolModelRequest): ModelResponse {
    const userMessage = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user');
    const text = userMessage?.content || '';
    interface MockPlanningIntentJson {
      items?: Array<{
        productId?: unknown;
        productName?: unknown;
        quantity?: unknown;
        unit?: unknown;
      }>;
      deadline?: { maxHours?: unknown };
    }
    let intentJson: MockPlanningIntentJson | null = null;
    try {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        intentJson = JSON.parse(text.slice(start, end + 1)) as MockPlanningIntentJson;
      }
    } catch {
      intentJson = null;
    }
    if (!intentJson || !Array.isArray(intentJson.items)) {
      return {
        content: 'Mock discovery planner could not parse the validated intent.',
        finishReason: 'stop',
      };
    }

    const personalCare = new Set([
      SEED_IDS.products.detergent,
      SEED_IDS.products.cleaningLiquid,
      SEED_IDS.products.toothbrushes,
    ]);
    const items = intentJson.items.map((item) => {
      const name = typeof item.productName === 'string' ? item.productName : 'goods';
      const isPersonalCare =
        typeof item.productId === 'string' && personalCare.has(item.productId);
      return {
        productId: item.productId,
        productName: name,
        quantity: item.quantity,
        unit: item.unit,
        searchTerms: [name, `${name} wholesale`, `${name} retail`],
        categories: isPersonalCare
          ? ['commercial.supermarket', 'commercial.chemist', 'commercial.department_store']
          : ['commercial.supermarket', 'commercial.wholesale', 'commercial.food_and_drink'],
        supplierTypes: isPersonalCare
          ? ['retail', 'chemist', 'supermarket']
          : ['wholesale', 'retail', 'grocery'],
      };
    });
    const args: Record<string, unknown> = {
      items,
      geography: { radiusKm: 5, expansionAllowed: false },
    };
    if (
      intentJson.deadline &&
      typeof intentJson.deadline.maxHours === 'number'
    ) {
      args.fulfillment = { maxHours: intentJson.deadline.maxHours };
    }

    return {
      content: '',
      toolCalls: [
        {
          id: 'call_plan_01',
          name: DISCOVERY_TOOL_NAME,
          arguments: args,
        },
      ],
      finishReason: 'tool_calls',
    };
  }

  private interpretQuoteDeterministic(request: ToolModelRequest): ModelResponse {
    const userMessage = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user');
    const text = userMessage?.content || '';
    const rawStart = text.indexOf('"""');
    const rawEnd = text.lastIndexOf('"""');
    const raw = rawStart >= 0 && rawEnd > rawStart
      ? text.slice(rawStart + 3, rawEnd)
      : text;

    interface GroupFacts {
      canonicalName: string;
      quantities: Array<{ value: number; unit: string; evidence: string }>;
      unitPrices: Array<{ value: number; pricingUnit: string; evidence: string }>;
      totals: Array<{ value: number; evidence: string }>;
      bareAmounts: number;
      moq?: { value: number; evidence: string };
      hasCurrency: boolean;
      currencyEvidence?: string;
    }
    const groups = new Map<string, GroupFacts>();
    const order: string[] = [];
    const getGroup = (canonical: string): GroupFacts => {
      let group = groups.get(canonical);
      if (!group) {
        group = {
          canonicalName: canonical,
          quantities: [],
          unitPrices: [],
          totals: [],
          bareAmounts: 0,
          hasCurrency: false,
        };
        groups.set(canonical, group);
        order.push(canonical);
      }
      return group;
    };

    const unitWord = '(kg|kilos?|kilograms?|grams?|g|litres?|liters?|l|ml|packs?|packets?|pieces?|units?|each)';
    const segments = raw
      .split(/[.;\n]+|,\s*(?=[A-Za-z])/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const noAmount = (segment: string): string =>
      segment.replace(/₹\s*[\d,]+(?:\.\d+)?/g, ' ').replace(/\bRs\.?\s*[\d,]+(?:\.\d+)?/g, ' ');

    for (const segment of segments) {
      const match = matchCatalogProduct(segment);
      const canonical = match?.canonicalName;
      const key = canonical ?? '__orphan__';
      const group = getGroup(key);

      const amountMatches = Array.from(
        segment.matchAll(/₹\s*([\d,]+(?:\.\d+)?)|\bRs\.?\s*([\d,]+(?:\.\d+)?)/gi)
      );
      if (amountMatches.length > 0) {
        group.hasCurrency = true;
        group.currencyEvidence = amountMatches[0][0];
      }
      const perUnitMatch = segment.match(new RegExp(`(?:\\/|per\\s+)${unitWord}\\b`, 'i'));
      const pricingWord = perUnitMatch
        ? perUnitMatch[1].toLowerCase()
        : /\beach\b/i.test(segment)
          ? 'each'
          : null;
      const isTotal = /\btotal\b/i.test(segment) || /\bfor\s+\d/i.test(segment);
      for (const amount of amountMatches) {
        const value = parseFloat((amount[1] ?? amount[2]).replace(/,/g, ''));
        if (Number.isNaN(value)) continue;
        // Delivery-fee amounts belong to the response level, not to an item.
        if (/delivery\s*fee/i.test(segment)) continue;
        if (pricingWord) {
          group.unitPrices.push({
            value,
            pricingUnit: pricingWord,
            evidence: amount[0],
          });
        } else if (isTotal) {
          group.totals.push({ value, evidence: amount[0] });
        } else {
          group.bareAmounts += 1;
        }
      }

      const clean = noAmount(segment);
      const qtyMatch = clean.match(
        new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unitWord}\\b`, 'i')
      );
      if (qtyMatch && !/\bmoq\b/i.test(segment) && !/\bminimum\b/i.test(segment)) {
        group.quantities.push({
          value: parseFloat(qtyMatch[1]),
          unit: qtyMatch[2].toLowerCase(),
          evidence: qtyMatch[0],
        });
      } else {
        const countMatch = clean.match(
          /(\d+(?:\.\d+)?)\s*(toothbrushes?|bananas?|oranges?|apples?)\b/i
        );
        if (countMatch) {
          group.quantities.push({
            value: parseFloat(countMatch[1]),
            unit: 'each',
            evidence: countMatch[0],
          });
        }
      }

      const moqMatch = segment.match(
        /\bmoq\b\s*(\d+(?:\.\d+)?)|minimum(?:\s+\w+){0,2}\s+(\d+(?:\.\d+)?)/i
      );
      if (moqMatch && group.moq === undefined) {
        group.moq = {
          value: parseFloat(moqMatch[1] ?? moqMatch[2]),
          evidence: moqMatch[0],
        };
      }
    }

    // Attach orphan segments to the single product group when unambiguous.
    const orphans = groups.get('__orphan__');
    if (orphans) {
      groups.delete('__orphan__');
      const named = order.filter((k) => k !== '__orphan__');
      if (
        named.length === 1 &&
        orphans.unitPrices.length +
          orphans.totals.length +
          orphans.quantities.length +
          orphans.bareAmounts +
          (orphans.moq ? 1 : 0) >
          0
      ) {
        const target = groups.get(named[0]) as GroupFacts;
        target.quantities.push(...orphans.quantities);
        target.unitPrices.push(...orphans.unitPrices);
        target.totals.push(...orphans.totals);
        target.bareAmounts += orphans.bareAmounts;
        if (orphans.moq && !target.moq) target.moq = orphans.moq;
        if (orphans.hasCurrency) {
          target.hasCurrency = true;
          target.currencyEvidence = target.currencyEvidence ?? orphans.currencyEvidence;
        }
      }
      const orphanIndex = order.indexOf('__orphan__');
      if (orphanIndex >= 0) order.splice(orphanIndex, 1);
    }

    const items: Record<string, unknown>[] = [];
    for (const key of order) {
      const group = groups.get(key) as GroupFacts;
      const item: Record<string, unknown> = { productName: group.canonicalName };
      const evidence: Record<string, string> = {};
      const flags: string[] = [];
      const missing: string[] = [];

      const distinctQty = Array.from(new Set(group.quantities.map((q) => q.value)));
      if (distinctQty.length > 1) {
        flags.push('QUANTITY_CONFLICT');
      }
      if (group.quantities.length > 0) {
        item.quantity = group.quantities[0].value;
        item.unit = group.quantities[0].unit;
        evidence.quantity = group.quantities[0].evidence;
        evidence.unit = group.quantities[0].evidence;
      } else {
        missing.push('quantity');
      }

      const distinctUnit = Array.from(new Set(group.unitPrices.map((p) => p.value)));
      if (distinctUnit.length > 1 || (group.unitPrices.length > 0 && group.bareAmounts > 0)) {
        flags.push('PRICE_CONFLICT');
      }
      if (
        group.unitPrices.length > 0 &&
        group.totals.length > 0 &&
        group.quantities.length > 0 &&
        Math.abs(
          group.unitPrices[0].value * group.quantities[0].value - group.totals[0].value
        ) > 0.01
      ) {
        flags.push('PRICE_CONFLICT');
      }
      if (group.unitPrices.length > 0) {
        item.unitPrice = group.unitPrices[0].value;
        item.pricingUnit = group.unitPrices[0].pricingUnit;
        evidence.unitPrice = group.unitPrices[0].evidence;
        evidence.pricingUnit = group.unitPrices[0].evidence;
      }
      if (group.totals.length > 0) {
        item.totalPrice = group.totals[0].value;
        evidence.totalPrice = group.totals[0].evidence;
      }
      if (group.unitPrices.length === 0 && group.totals.length === 0) {
        if (group.bareAmounts > 0) {
          flags.push('PRICE_UNIT_UNCLEAR');
        }
        missing.push('unit_price');
      }
      if (group.hasCurrency && (item.unitPrice !== undefined || item.totalPrice !== undefined)) {
        item.currency = 'INR';
        if (group.currencyEvidence) evidence.currency = group.currencyEvidence;
      } else if (item.unitPrice !== undefined || item.totalPrice !== undefined) {
        flags.push('CURRENCY_UNCLEAR');
      }
      if (group.moq) {
        item.minimumQuantity = group.moq.value;
        evidence.minimumQuantity = group.moq.evidence;
      }
      if (Object.keys(evidence).length > 0) item.evidence = evidence;
      if (flags.length > 0) item.ambiguityFlags = flags;
      if (missing.length > 0) item.missingFields = missing;
      items.push(item);
    }

    if (items.length === 0) {
      const excerpt = raw.trim().replace(/\s+/g, ' ').slice(0, 60) || 'this response';
      items.push({
        productName: excerpt,
        ambiguityFlags: ['PRODUCT_UNCLEAR'],
        missingFields: ['product', 'quantity', 'unit_price'],
      });
    }

    const args: Record<string, unknown> = { items };
    const hoursMatch = raw.match(/(?:within|in)\s*(\d+(?:\.\d+)?)\s*hours?/i)
      ?? raw.match(/delivery[^\d]{0,20}(\d+(?:\.\d+)?)\s*hours?/i);
    const feeMatch = raw.match(/delivery\s*fee\s*₹\s*([\d,]+(?:\.\d+)?)/i);
    const responseMissing: string[] = [];
    const responseFlags: string[] = [];
    if (hoursMatch || feeMatch) {
      const delivery: Record<string, unknown> = {};
      const deliveryEvidence: Record<string, string> = {};
      if (hoursMatch) {
        delivery.maxHours = parseFloat(hoursMatch[1]);
        deliveryEvidence.maxHours = hoursMatch[0];
      }
      if (feeMatch) {
        delivery.deliveryFee = parseFloat(feeMatch[1].replace(/,/g, ''));
        deliveryEvidence.deliveryFee = feeMatch[0];
      }
      delivery.evidence = deliveryEvidence;
      args.delivery = delivery;
    } else {
      responseMissing.push('delivery_time');
      if (/tomorrow|morning|evening|soon|asap|shortly|early/i.test(raw)) {
        responseFlags.push('DELIVERY_TIME_UNCLEAR');
      }
    }
    const refMatch = raw.match(/\bref(?:erence)?[\s#:]*([A-Za-z0-9-]{2,20})/i);
    if (refMatch) {
      args.supplierReference = refMatch[1];
    }
    if (responseMissing.length > 0) args.missingFields = responseMissing;
    if (responseFlags.length > 0) args.ambiguityFlags = responseFlags;

    return {
      content: '',
      toolCalls: [
        {
          id: 'call_quote_01',
          name: QUOTE_TOOL_NAME,
          arguments: args,
        },
      ],
      finishReason: 'tool_calls',
    };
  }

  private proposeStrategyDeterministic(request: ToolModelRequest): ModelResponse {
    const userMessage = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user');
    const text = userMessage?.content || '';
    interface MockStrategyContextJson {
      quoteId?: unknown;
      rfqId?: unknown;
      supplierId?: unknown;
      productId?: unknown;
      productName?: unknown;
      quantity?: unknown;
      unit?: unknown;
      unitPrice?: unknown;
      deliveryFee?: unknown;
      deliveryEtaHours?: unknown;
      moqQuantity?: unknown;
      slaMaxHours?: unknown;
      currentRound?: unknown;
      maxRounds?: unknown;
      communityQuantity?: unknown;
    }
    let ctx: MockStrategyContextJson | null = null;
    try {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        ctx = JSON.parse(text.slice(start, end + 1)) as MockStrategyContextJson;
      }
    } catch {
      ctx = null;
    }
    if (!ctx || typeof ctx.quoteId !== 'string') {
      return {
        content: 'Mock negotiation strategist could not parse the verified context.',
        finishReason: 'stop',
      };
    }

    const num = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const quantity = num(ctx.quantity) ?? 0;
    const unitPrice = num(ctx.unitPrice) ?? 0;
    const deliveryFee = num(ctx.deliveryFee) ?? 0;
    const deliveryEtaHours = num(ctx.deliveryEtaHours);
    const moqQuantity = num(ctx.moqQuantity);
    const slaMaxHours = num(ctx.slaMaxHours) ?? 12;
    const currentRound = num(ctx.currentRound) ?? 0;
    const maxRounds = num(ctx.maxRounds) ?? 3;
    const communityQuantity = num(ctx.communityQuantity);

    let action: string;
    let priority: string;
    let requestedChange: Record<string, unknown> | undefined;
    let objective: string;
    let rationale: string;
    let expectedBenefit: string;

    if (currentRound + 1 > maxRounds) {
      action = 'STOP_NEGOTIATION';
      priority = 'NONE';
      objective = 'Stop negotiation at the round limit.';
      rationale = `Maximum ${maxRounds} rounds reached; stop negotiation.`;
      expectedBenefit = 'Best verified quote retained.';
    } else if (moqQuantity !== undefined && moqQuantity > quantity) {
      action = 'REQUEST_LOWER_MOQ';
      priority = 'MOQ';
      requestedChange = { targetQuantity: quantity };
      objective = 'Align the order minimum with the required quantity.';
      rationale = `MOQ ${moqQuantity} exceeds required ${quantity}; request alignment to required quantity.`;
      expectedBenefit = 'Usable quote for the required quantity.';
    } else if (deliveryFee > 0) {
      action = 'REQUEST_DELIVERY_FEE_REDUCTION';
      priority = 'DELIVERY_FEE';
      requestedChange = { targetDeliveryFee: 0 };
      objective = 'Remove the delivery fee.';
      rationale = `Delivery fee of ${deliveryFee} can be reduced to zero.`;
      expectedBenefit = `Save ${deliveryFee} on delivery.`;
    } else if (communityQuantity !== undefined && communityQuantity > quantity) {
      action = 'REQUEST_BUNDLE_DISCOUNT';
      priority = 'BUNDLE';
      objective = 'Request a bundle consideration for pooled quantity.';
      rationale = `Pooled quantity ${communityQuantity} supports a bundle request.`;
      expectedBenefit = 'Possible volume consideration.';
    } else if (
      deliveryEtaHours !== undefined &&
      deliveryEtaHours > slaMaxHours - 3
    ) {
      action = 'REQUEST_DELIVERY_IMPROVEMENT';
      priority = 'DELIVERY';
      requestedChange = { targetDeliveryEtaHours: deliveryEtaHours - 1 };
      objective = 'Gain delivery headroom before the commitment.';
      rationale = `Delivery ${deliveryEtaHours}h is close to the ${slaMaxHours}h commitment; request ${deliveryEtaHours - 1}h.`;
      expectedBenefit = 'Additional delivery headroom.';
    } else if (unitPrice > 0) {
      action = 'REQUEST_PRICE_REDUCTION';
      priority = 'PRICE';
      const target = Math.round(unitPrice * 0.95 * 100) / 100;
      requestedChange = { targetUnitPrice: target };
      objective = 'Reduce the unit price modestly.';
      rationale = `Unit price ${unitPrice} can improve by five percent while delivery meets the commitment.`;
      expectedBenefit = 'Lower per-unit cost.';
    } else {
      action = 'STOP_NEGOTIATION';
      priority = 'NONE';
      objective = 'Stop negotiation when no lever applies.';
      rationale = 'No positive price to improve; stop negotiation.';
      expectedBenefit = 'Best verified quote retained.';
    }

    const args: Record<string, unknown> = {
      action,
      priority,
      objective,
      quoteId: ctx.quoteId,
      rfqId: ctx.rfqId,
      supplierId: ctx.supplierId,
      productId: ctx.productId,
      productName: ctx.productName,
      quantity: ctx.quantity,
      unit: ctx.unit,
      roundNumber: currentRound,
      rationale,
      expectedBenefit,
      constraintsAcknowledged: [
        `${quantity} ${ctx.unit} required`,
        `${slaMaxHours}-hour delivery limit`,
      ],
      stopConditions: [`Protect the ${slaMaxHours}-hour delivery commitment.`],
    };
    if (requestedChange) args.requestedChange = requestedChange;
    if (action === 'REQUEST_BUNDLE_DISCOUNT' && communityQuantity !== undefined) {
      args.communityQuantity = communityQuantity;
    }

    return {
      content: '',
      toolCalls: [
        {
          id: 'call_strategy_01',
          name: NEGOTIATION_TOOL_NAME,
          arguments: args,
        },
      ],
      finishReason: 'tool_calls',
    };
  }

  private planRouteDeterministic(request: ToolModelRequest): ModelResponse {
    const userMessage = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user');
    const text = userMessage?.content || '';
    interface MockRoutingContextJson {
      currentStage?: unknown;
      workflowStatus?: unknown;
      intent?: {
        status?: unknown;
        itemCount?: unknown;
        quantities?: unknown;
        units?: unknown;
        deadlineHours?: unknown;
      };
      suppliersDiscovered?: unknown;
      suppliersQualified?: unknown;
      quotesReceived?: unknown;
      rawResponsesPending?: unknown;
      negotiationEligible?: unknown;
      awaitingExternal?: unknown;
      blockers?: unknown;
    }
    let ctx: MockRoutingContextJson | null = null;
    try {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        ctx = JSON.parse(text.slice(start, end + 1)) as MockRoutingContextJson;
      }
    } catch {
      ctx = null;
    }
    if (!ctx || typeof ctx.currentStage !== 'string') {
      return {
        content: 'Mock orchestration router could not parse the verified context.',
        finishReason: 'stop',
      };
    }

    const num = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const stage = ctx.currentStage;
    const status = typeof ctx.workflowStatus === 'string' ? ctx.workflowStatus : '';
    const intentStatus = typeof ctx.intent?.status === 'string' ? ctx.intent.status : 'missing';
    const quantities = Array.isArray(ctx.intent?.quantities)
      ? (ctx.intent.quantities as unknown[]).filter((q): q is number => typeof q === 'number')
      : [];
    const units = Array.isArray(ctx.intent?.units)
      ? (ctx.intent.units as unknown[]).filter((u): u is string => typeof u === 'string')
      : [];
    const deadlineHours = num(ctx.intent?.deadlineHours);
    const discovered = num(ctx.suppliersDiscovered) ?? 0;
    const qualified = num(ctx.suppliersQualified) ?? 0;
    const quotes = num(ctx.quotesReceived) ?? 0;
    const rawPending = num(ctx.rawResponsesPending) ?? 0;
    const eligible = ctx.negotiationEligible === true;
    const awaiting = ctx.awaitingExternal === true;
    const blockers = Array.isArray(ctx.blockers) ? ctx.blockers : [];

    let action: string;
    let target: string;
    let priority: string;
    let objective: string;
    let rationale: string;

    if (
      status === 'COMPLETED' ||
      status === 'FAILED' ||
      status === 'CANCELLED' ||
      stage === 'COMPLETE'
    ) {
      action = 'STOP_AUTONOMOUS_RUN';
      target = stage;
      priority = 'STOP';
      objective = 'Stop a terminal workflow.';
      rationale = 'Workflow is terminal; stop the autonomous run.';
    } else if (blockers.length > 0) {
      action = 'STOP_AUTONOMOUS_RUN';
      target = stage;
      priority = 'STOP';
      objective = 'Stop while blockers are present.';
      rationale = `Blocker present (${String(blockers[0])}); stop the autonomous run.`;
    } else if (intentStatus !== 'resolved') {
      if (stage === 'UNDERSTAND') {
        action = 'UNDERSTAND_REQUEST';
        target = 'UNDERSTAND';
        priority = 'UNDERSTAND';
        objective = 'Understand the community request.';
        rationale = 'Intent is not resolved; run understanding first.';
      } else {
        action = 'REQUEST_CLARIFICATION';
        target = stage;
        priority = 'CLARIFY';
        objective = 'Clarify the unresolved request.';
        rationale = 'Intent is unresolved outside understanding; request clarification.';
      }
    } else if (awaiting) {
      action = 'WAIT_FOR_EXTERNAL_RESPONSE';
      target = stage;
      priority = 'WAIT';
      objective = 'Wait for the pending external event.';
      rationale = 'An external response is pending; wait for it.';
    } else if (stage === 'UNDERSTAND') {
      action = 'PLAN_DISCOVERY';
      target = 'DISCOVER';
      priority = 'DISCOVER';
      objective = 'Plan supplier discovery for verified intent.';
      rationale = 'Intent verified; plan discovery next.';
    } else if (stage === 'DISCOVER') {
      if (discovered > 0) {
        action = 'QUALIFY_SUPPLIERS';
        target = 'QUALIFY';
        priority = 'QUALIFY';
        objective = 'Qualify discovered suppliers.';
        rationale = 'Suppliers discovered; qualify them next.';
      } else {
        action = 'WAIT_FOR_EXTERNAL_RESPONSE';
        target = stage;
        priority = 'WAIT';
        objective = 'Wait for discovery results.';
        rationale = 'No suppliers discovered yet; wait for results.';
      }
    } else if (stage === 'QUALIFY') {
      if (qualified > 0) {
        action = 'REQUEST_QUOTES';
        target = 'QUOTE';
        priority = 'QUOTE';
        objective = 'Request quotes from qualified suppliers.';
        rationale = 'Suppliers qualified; request quotes next.';
      } else {
        action = 'STOP_AUTONOMOUS_RUN';
        target = stage;
        priority = 'STOP';
        objective = 'Stop with no eligible suppliers.';
        rationale = 'No qualified suppliers remain; stop the run.';
      }
    } else if (stage === 'QUOTE') {
      if (rawPending > 0) {
        action = 'INTERPRET_QUOTES';
        target = 'QUOTE';
        priority = 'QUOTE';
        objective = 'Interpret pending supplier responses.';
        rationale = 'Raw supplier responses are pending; interpret them.';
      } else if (eligible) {
        action = 'PLAN_NEGOTIATION';
        target = 'NEGOTIATE';
        priority = 'NEGOTIATE';
        objective = 'Plan negotiation for the verified quote.';
        rationale = 'Quote eligible for negotiation; plan strategy.';
      } else if (quotes > 0) {
        action = 'SELECT_SUPPLIER';
        target = 'SELECT';
        priority = 'SELECT';
        objective = 'Select the winning supplier.';
        rationale = 'Verified quotes available; select the winner.';
      } else {
        action = 'WAIT_FOR_EXTERNAL_RESPONSE';
        target = stage;
        priority = 'WAIT';
        objective = 'Wait for supplier quotes.';
        rationale = 'No quotes yet; wait for supplier responses.';
      }
    } else if (stage === 'NEGOTIATE') {
      if (eligible) {
        action = 'PLAN_NEGOTIATION';
        target = 'NEGOTIATE';
        priority = 'NEGOTIATE';
        objective = 'Plan the next negotiation round.';
        rationale = 'Negotiation eligible; plan the next round.';
      } else if (quotes > 0) {
        action = 'SELECT_SUPPLIER';
        target = 'SELECT';
        priority = 'SELECT';
        objective = 'Select the winning supplier.';
        rationale = 'Negotiation closed; select the winner.';
      } else {
        action = 'STOP_AUTONOMOUS_RUN';
        target = stage;
        priority = 'STOP';
        objective = 'Stop with no negotiable quotes.';
        rationale = 'No quotes available; stop the run.';
      }
    } else {
      action = 'STOP_AUTONOMOUS_RUN';
      target = stage;
      priority = 'STOP';
      objective = 'Stop advisory routing past selection.';
      rationale = 'Downstream stages are deterministic; stop advisory routing.';
    }

    const verifiedContext: Record<string, unknown> = {
      itemCount: quantities.length,
      quantities,
      units,
    };
    if (deadlineHours !== undefined) verifiedContext.deadlineHours = deadlineHours;

    return {
      content: '',
      toolCalls: [
        {
          id: 'call_route_01',
          name: ORCHESTRATION_TOOL_NAME,
          arguments: {
            action,
            currentStage: stage,
            targetStage: target,
            priority,
            objective,
            rationale,
            verifiedContext,
            requiredCapabilities: [action],
            requiredContext: ['workflow-status', 'policy-constraints'],
            constraintsAcknowledged: [`${quantities.length} verified items`],
            stopConditions:
              deadlineHours !== undefined
                ? [`Protect the ${deadlineHours}-hour delivery commitment.`]
                : ['Do not weaken verified hard constraints.'],
          },
        },
      ],
      finishReason: 'tool_calls',
    };
  }

  public async generateWithTools(request: ToolModelRequest): Promise<ModelResponse> {
    // If a custom script is provided, advance through it
    if (this.scriptedSequence.length > 0) {
      if (this.currentStepIndex >= this.scriptedSequence.length) {
        return {
          content: 'Workflow completed according to script.',
          finishReason: 'stop',
        };
      }
      const step = this.scriptedSequence[this.currentStepIndex++];
      if (step.toolCall) {
        return {
          content: step.content || 'Calling tool as scripted...',
          toolCalls: [step.toolCall],
          finishReason: 'tool_calls',
        };
      }
      return {
        content: step.content || 'Mock completed.',
        finishReason: 'stop',
      };
    }

    // Phase 14.2 deterministic intent-extraction mode (inference only).
    // Active only when the caller offers the extraction tool; the default
    // procurement loop below is untouched.
    if (request.tools?.some((t) => t.name === INTENT_TOOL_NAME)) {
      return this.extractIntentDeterministic(request);
    }

    // Phase 14.3 deterministic discovery-planning mode (inference only).
    if (request.tools?.some((t) => t.name === DISCOVERY_TOOL_NAME)) {
      return this.planDiscoveryDeterministic(request);
    }

    // Phase 14.4 deterministic quote-interpretation mode (inference only).
    if (request.tools?.some((t) => t.name === QUOTE_TOOL_NAME)) {
      return this.interpretQuoteDeterministic(request);
    }

    // Phase 14.5 deterministic negotiation-strategy mode (inference only).
    if (request.tools?.some((t) => t.name === NEGOTIATION_TOOL_NAME)) {
      return this.proposeStrategyDeterministic(request);
    }

    // Phase 15 deterministic orchestration-routing mode (inference only).
    if (request.tools?.some((t) => t.name === ORCHESTRATION_TOOL_NAME)) {
      return this.planRouteDeterministic(request);
    }

    // Default autonomous procurement loop
    const lastMessage = request.messages[request.messages.length - 1];

    // If starting fresh from user prompt
    if (lastMessage.role === 'user') {
      // Per-run hygiene: this provider instance is shared across runs, so no
      // intent or order state may leak from one command into the next.
      this.reset();
      const intent = parseUserIntent(lastMessage.content || '');

      if (intent.unsupportedItem) {
        return {
          content:
            `I need a little more information — I understood you want something procured ("${intent.unsupportedItem}"), ` +
            `but I could not identify the exact product or quantity yet. ` +
            `Please restate the request with product, quantity, and unit.`,
          finishReason: 'stop',
          raw: { code: 'UNMAPPABLE_PRODUCT' },
        };
      }

      const primary = intent.matches[0];
      this.activeIntent = primary;

      return {
        content: `Analyzing resident request. Initiating procurement request creation for ${primary.quantity} ${primary.unit} ${primary.productName}...`,
        toolCalls: [
          {
            id: 'call_create_req_01',
            name: 'createRequest',
            arguments: {
              productId: primary.productId,
              quantity: primary.quantity,
              unit: primary.unit,
            },
          },
        ],
        finishReason: 'tool_calls',
      };
    }

    // If following up after a tool response
    if (lastMessage.role === 'tool') {
      const toolResult = this.parseToolResult(lastMessage.content);
      const toolName = lastMessage.name;

      if (toolName === 'createRequest') {
        const orderId = toolResult?.orderId || 'res_order_001';
        this.lastCreatedOrderId = orderId;
        const requestedPrice = Number(toolResult?.totalPrice || toolResult?.totalAmount || 825.0);
        this.lastRequestedPrice = requestedPrice;
        const prodName = toolResult?.productName || this.activeIntent?.productName || 'Bulk Goods';
        return {
          content: `Request validated (Order: ${orderId}). Verifying pre-authorized spending mandate...`,
          toolCalls: [
            {
              id: 'call_check_auth_02',
              name: 'checkAuthorization',
              arguments: {
                requestedAmount: requestedPrice,
                purpose: `Community Procurement: ${prodName}`,
              },
            },
          ],
          finishReason: 'tool_calls',
        };
      }

      if (toolName === 'checkAuthorization') {
        return {
          content: 'Mandate limit verified. Aggregating compatible community demand...',
          toolCalls: [
            {
              id: 'call_agg_demand_03',
              name: 'aggregateDemand',
              arguments: {},
            },
          ],
          finishReason: 'tool_calls',
        };
      }

      if (toolName === 'aggregateDemand') {
        const activeItem = this.activeIntent;
        if (!activeItem) {
          throw new Error('MockModelProvider: tool follow-up without a mapped intent; refusing to substitute a product.');
        }
        return {
          content: 'Demand pooled across society units. Discovering compliant suppliers within 12h SLA...',
          toolCalls: [
            {
              id: 'call_disc_suppliers_04',
              name: 'discoverSuppliers',
              arguments: {
                productId: activeItem.productId,
                requestedQuantity: activeItem.quantity,
                maxSlaHours: 12.0,
              },
            },
          ],
          finishReason: 'tool_calls',
        };
      }

      if (toolName === 'discoverSuppliers') {
        const activeItem = this.activeIntent;
        if (!activeItem) {
          throw new Error('MockModelProvider: tool follow-up without a mapped intent; refusing to substitute a product.');
        }
        return {
          content: 'Suppliers discovered and filtered against hard constraints. Requesting and evaluating quotes...',
          toolCalls: [
            {
              id: 'call_eval_offers_05',
              name: 'evaluateOffers',
              arguments: {
                productId: activeItem.productId,
                totalQuantity: activeItem.quantity,
              },
            },
          ],
          finishReason: 'tool_calls',
        };
      }

      if (toolName === 'evaluateOffers') {
        const activeItem = this.activeIntent;
        if (!activeItem) {
          throw new Error('MockModelProvider: tool follow-up without a mapped intent; refusing to substitute a product.');
        }
        return {
          content: 'Offers ranked using multi-factor economics and SLA speed. Selecting optimal compliant offer...',
          toolCalls: [
            {
              id: 'call_select_offer_06',
              name: 'selectOffer',
              arguments: {
                productId: activeItem.productId,
                totalQuantity: activeItem.quantity,
              },
            },
          ],
          finishReason: 'tool_calls',
        };
      }

      if (toolName === 'selectOffer') {
        const winningSupplierId = toolResult?.supplierId || '33333333-3333-4333-8333-333333333301';
        const deadline = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
        const contributingResidentOrderIds = this.lastCreatedOrderId
          ? [this.lastCreatedOrderId]
          : undefined;

        const activeItem = this.activeIntent;
        if (!activeItem) {
          throw new Error('MockModelProvider: tool follow-up without a mapped intent; refusing to substitute a product.');
        }
        const winningTotal = Number(toolResult?.totalPrice || this.lastRequestedPrice || 825.0);
        const unitPrice = (winningTotal / activeItem.quantity).toFixed(2);
        this.lastRequestedPrice = winningTotal;

        return {
          content: 'Offer selected. Atomically creating community procurement order...',
          toolCalls: [
            {
              id: 'call_create_comm_order_07',
              name: 'createCommunityOrder',
              arguments: {
                supplierId: winningSupplierId,
                deliveryDeadline: deadline,
                idempotencyKey: `IDEMP-AGENT-SCENARIO-${Date.now()}`,
                contributingResidentOrderIds,
                items: [
                  {
                    productId: activeItem.productId,
                    totalQuantity: activeItem.quantity.toFixed(4),
                    negotiatedUnitPrice: unitPrice,
                  },
                ],
              },
            },
          ],
          finishReason: 'tool_calls',
        };
      }

      if (toolName === 'createCommunityOrder') {
        const communityOrderId = toolResult?.order?.id || 'comm_order_001';
        const resOrderId = this.lastCreatedOrderId || '66666666-6666-4666-8666-666666666601';
        this.lastCommunityOrderId = communityOrderId;
        const activeItem = this.activeIntent;
        if (!activeItem) {
          throw new Error('MockModelProvider: tool follow-up without a mapped intent; refusing to substitute a product.');
        }
        return {
          content: `Community order ${communityOrderId} confirmed. Allocating batch quantities to resident units...`,
          toolCalls: [
            {
              id: 'call_allocate_08',
              name: 'allocateResidentOrders',
              arguments: {
                communityOrderId,
                allocations: [
                  {
                    residentOrderId: resOrderId,
                    productId: activeItem.productId,
                    quantity: activeItem.quantity.toFixed(4),
                  },
                ],
              },
            },
          ],
          finishReason: 'tool_calls',
        };
      }

      if (toolName === 'allocateResidentOrders') {
        const communityOrderId = toolResult?.communityOrderId || this.lastCommunityOrderId || 'comm_order_001';
        const resOrderId = this.lastCreatedOrderId || '66666666-6666-4666-8666-666666666601';

        const userMsg = request.messages.find((m) => m.role === 'user')?.content?.toLowerCase() || '';
        const isFullCycle =
          userMsg.includes('community procurement') ||
          userMsg.includes('better deal') ||
          userMsg.includes('full-cycle') ||
          userMsg.includes('e2e');

        if (isFullCycle) {
          return {
            content: 'Unit allocation verified. Executing pre-authorized resident payment under verified mandate...',
            toolCalls: [
              {
                id: 'call_req_payment_09',
                name: 'requestPayment',
                arguments: {
                  residentOrderId: resOrderId,
                  amount: this.lastRequestedPrice || 825.0,
                  idempotencyKey: `IDEMP-PAY-${resOrderId}`,
                },
              },
            ],
            finishReason: 'tool_calls',
          };
        }

        return {
          content: 'Unit allocation verified. Executing multi-dimensional financial & quantity reconciliation...',
          toolCalls: [
            {
              id: 'call_reconcile_09',
              name: 'reconcileOrder',
              arguments: {
                communityOrderId,
              },
            },
          ],
          finishReason: 'tool_calls',
        };
      }

      if (toolName === 'requestPayment') {
        const communityOrderId = this.lastCommunityOrderId || 'comm_order_001';
        return {
          content: 'Payment successfully settled under mandate cap. Tracking and advancing delivery fulfillment...',
          toolCalls: [
            {
              id: 'call_track_delivery_10',
              name: 'trackDelivery',
              arguments: {
                communityOrderId,
                advanceStatus: 'DELIVERED',
              },
            },
          ],
          finishReason: 'tool_calls',
        };
      }

      if (toolName === 'trackDelivery') {
        const communityOrderId = toolResult?.communityOrderId || this.lastCommunityOrderId || 'comm_order_001';
        return {
          content: 'Delivery safely reached society security gate. Executing final deterministic reconciliation...',
          toolCalls: [
            {
              id: 'call_reconcile_11',
              name: 'reconcileOrder',
              arguments: {
                communityOrderId,
              },
            },
          ],
          finishReason: 'tool_calls',
        };
      }

      if (toolName === 'reconcileOrder') {
        // The final message must derive from authoritative recorded tool
        // outcomes — never claim success when required steps failed.
        const failures = this.collectToolFailures(request.messages);
        if (failures.length > 0) {
          return {
            content:
              `Relay could not complete this procurement run. ${failures.length} backend step(s) reported failures (${failures.map((f) => f.name).join(', ')}). ` +
              `First failure: ${failures[0].message} No order was secured. Review the marked stages for the exact errors.`,
            finishReason: 'stop',
          };
        }
        // The success message names ONLY the mapped intent or the recorded
        // order evidence — a fallback product here would be substitution.
        const recorded = findRecordedOrderItem(request.messages);
        const item = this.activeIntent
          ? {
              quantity: this.activeIntent.quantity,
              unit: this.activeIntent.unit,
              productName: this.activeIntent.productName,
            }
          : recorded;
        if (!item) {
          return {
            content:
              'Relay autonomous procurement is complete. Your order has been secured through community demand pooling under pre-authorized spending caps within the 12-hour fulfillment SLA.',
            finishReason: 'stop',
          };
        }
        const itemDesc = `${item.quantity}${item.unit === 'LITRE' ? 'L' : ` ${item.unit}`} ${item.productName.replace('Cold-Pressed ', '')}`;
        return {
          content:
            `Relay autonomous procurement is complete. Your order for ${itemDesc} has been secured through community demand pooling under pre-authorized spending caps within the 12-hour fulfillment SLA.`,
          finishReason: 'stop',
        };
      }
    }

    // Default fallback completion
    return {
      content: 'Relay Agent task finished successfully.',
      finishReason: 'stop',
    };
  }

  private parseToolResult(content: string): Record<string, any> | null {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Scans recorded tool messages for backend-reported failures
   * (`{ success: false, error: { message } }`). A tool that ran but rejected
   * (e.g. authorization denied) counts as failed: nothing was secured.
   */
  private collectToolFailures(
    messages: Array<{ role: string; name?: string; content: string }>
  ): Array<{ name: string; message: string }> {
    const failures: Array<{ name: string; message: string }> = [];
    for (const m of messages) {
      if (m.role !== 'tool') continue;
      const parsed = this.parseToolResult(m.content || '');
      if (parsed && (parsed.success === false || parsed.error)) {
        const err = (parsed.error ?? {}) as Record<string, unknown>;
        failures.push({
          name: m.name || 'tool',
          message:
            typeof err.message === 'string' && err.message.length > 0
              ? err.message
              : 'Tool reported failure',
        });
      }
    }
    return failures;
  }
}
