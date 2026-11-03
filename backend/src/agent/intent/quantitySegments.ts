/**
 * Shared structural segmentation for quantity-led procurement text.
 *
 * ONE generic rule, used identically by every intent path (mock segment
 * parsing and deterministic repair of model-emitted items): a fresh
 * quantity starts a new segment. Never a boundary: quantities inside
 * commercial price cues or ₹ amounts, range/code digits ("2-3", "WD-40",
 * "No. 5"), or a pack size ("2 bottles 500 ml") when the current span
 * already consumed a container/count unit.
 *
 * Purely structural — no product, brand, or request vocabulary. Quantities
 * re-emitted by a split always come from the text itself; nothing is
 * invented, and anything that does not parse cleanly is left untouched.
 */

export const PRICE_CUE_RE = /₹\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:₹|rs\.?|rupees?)/i;
export const BARE_PRICE_MARKER_RE = /(\d+(?:\.\d+)?)\s*(wale|wali|wale|ke|ki|ka)\b/i;

export interface PriceSpan {
  start: number;
  end: number;
}

/** Price spans are commercial cues, never quantities (e.g. "10 rs wale"). */
export function findPriceSpans(text: string): PriceSpan[] {
  const spans: PriceSpan[] = [];
  const priceRe = new RegExp(PRICE_CUE_RE.source, 'gi');
  let pm: RegExpExecArray | null;
  while ((pm = priceRe.exec(text)) !== null) {
    spans.push({ start: pm.index, end: pm.index + pm[0].length });
  }
  const bareRe = new RegExp(BARE_PRICE_MARKER_RE.source, 'gi');
  while ((pm = bareRe.exec(text)) !== null) {
    spans.push({ start: pm.index, end: pm.index + pm[0].length });
  }
  return spans;
}

const PACK_SIZE_UNIT_RE = /^\s*(ml|g|kg|l|litres?|liters?|grams?)\b/i;
const QTY_TOKEN_RE = /\d+(?:\.\d+)?/g;
// Identifier markers: the digits name the product ("No. 5", "#5"), they are
// not a quantity. A bare letter or '-' immediately before the digits means
// a code or range ("WD-40", "2-3").
const CODE_PREDECESSOR_RE = /[-a-zA-Z#]$/;
const IDENTIFIER_MARKER_RE = /\bno\.?\s+$/i;

/**
 * Absolute index of the next quantity that starts a NEW segment within
 * [from, to), or -1 when there is none.
 */
export function findNextSegmentQty(
  text: string,
  from: number,
  to: number,
  insidePriceSpan: (index: number) => boolean,
  segHasContainerUnit: boolean
): number {
  const re = new RegExp(QTY_TOKEN_RE.source, 'g');
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && m.index < to) {
    if (insidePriceSpan(m.index)) continue;
    if (m.index > 0 && text[m.index - 1] === '₹') continue;
    const before = m.index > 0 ? text.slice(Math.max(0, m.index - 8), m.index) : '';
    if (CODE_PREDECESSOR_RE.test(before) || IDENTIFIER_MARKER_RE.test(before)) continue;
    if (
      segHasContainerUnit &&
      PACK_SIZE_UNIT_RE.test(text.slice(m.index + m[0].length))
    ) {
      continue;
    }
    return m.index;
  }
  return -1;
}

export interface QuantitySegment {
  text: string;
  quantity?: number;
  unit?: string;
}

/**
 * Splits a product phrase on quantity boundaries ("cola 2 bottles juice"
 * → ["cola", {2, bottles, "juice"}]). The first piece keeps the caller's
 * quantity/unit; later pieces carry the quantities stated in the text plus
 * a unit word only when `isUnitWord` accepts it. Leading digits are the
 * NAME ("7 Up"), never a boundary. Returns the untouched single phrase
 * whenever anything does not parse cleanly — never manufactures fragments.
 */
export function splitQuantitySegments(
  phrase: string,
  opts: {
    segHasContainerUnit: boolean;
    insidePriceSpan: (index: number) => boolean;
    isUnitWord: (word: string) => boolean;
  }
): QuantitySegment[] {
  const text = phrase.trim();
  const single: QuantitySegment[] = [{ text }];
  const cuts: number[] = [];
  let from = 0;
  for (;;) {
    const cut = findNextSegmentQty(text, from, text.length, opts.insidePriceSpan, opts.segHasContainerUnit);
    if (cut === -1) break;
    if (cut === 0) {
      from = 1;
      continue;
    }
    cuts.push(cut);
    const token = /^\d+(?:\.\d+)?/.exec(text.slice(cut));
    from = cut + (token?.[0].length ?? 1);
  }
  if (cuts.length === 0) return single;
  const bounds = [0, ...cuts, text.length];
  const pieces: QuantitySegment[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const span = text.slice(bounds[i], bounds[i + 1]).trim();
    if (i === 0) {
      if (!span) return single;
      pieces.push({ text: span });
      continue;
    }
    const qtyMatch = /^\d+(?:\.\d+)?/.exec(span);
    if (!qtyMatch) return single;
    const quantity = parseFloat(qtyMatch[0]);
    let rest = span.slice(qtyMatch[0].length).trim();
    let unit: string | undefined;
    const firstWord = rest.split(/\s+/)[0] ?? '';
    if (firstWord && opts.isUnitWord(firstWord)) {
      unit = firstWord;
      rest = rest.slice(firstWord.length).trim();
    }
    if (!Number.isFinite(quantity) || !rest) return single;
    pieces.push({ text: rest, quantity, ...(unit ? { unit } : {}) });
  }
  return pieces;
}
