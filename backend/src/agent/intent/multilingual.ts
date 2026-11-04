/**
 * Multilingual Indic (Hindi, Marathi, Hinglish) and Devanagari text normalization utilities.
 */

/**
 * Normalizes Unicode text:
 * 1. Converts to standard Unicode NFC form (unifying decomposed combining diacritics/matras).
 * 2. Strips invisible zero-width characters (\u200B zero-width space, \u200C ZWNJ, \u200D ZWJ, \uFEFF BOM).
 * 3. Normalizes Indic punctuation (Devanagari danda \u0964 and double danda \u0965) to standard delimiters.
 * 4. Normalizes typographic quotes to standard ASCII quotes.
 */
export function normalizeIndicUnicode(text: string): string {
  if (!text) return '';
  return text
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/[।॥]/gu, ' , ')
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201C\u201D]/gu, '"');
}

/**
 * Normalizes Devanagari numerals (०-९) to ASCII digits (0-9) after Unicode cleaning.
 */
export function normalizeDevanagariNumerals(text: string): string {
  const cleaned = normalizeIndicUnicode(text);
  return cleaned.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
}

/**
 * Normalizes common spoken Hindi and Marathi number words to ASCII numbers.
 */
const INDIC_NUMBER_WORDS: [RegExp, string][] = [
  [/(?:^|[^\p{L}\p{M}\p{N}])(?:दोनशे|दो सौ|two hundred)(?=$|[^\p{L}\p{M}\p{N}])/gui, ' 200 '],
  [/(?:^|[^\p{L}\p{M}\p{N}])(?:शंभर|एक सौ|one hundred)(?=$|[^\p{L}\p{M}\p{N}])/gui, ' 100 '],
  [/(?:^|[^\p{L}\p{M}\p{N}])(?:तीनशे|तीन सौ|three hundred)(?=$|[^\p{L}\p{M}\p{N}])/gui, ' 300 '],
  [/(?:^|[^\p{L}\p{M}\p{N}])(?:चारशे|चार सौ|four hundred)(?=$|[^\p{L}\p{M}\p{N}])/gui, ' 400 '],
  [/(?:^|[^\p{L}\p{M}\p{N}])(?:पाचशे|पांच सौ|five hundred)(?=$|[^\p{L}\p{M}\p{N}])/gui, ' 500 '],
  [/(?:^|[^\p{L}\p{M}\p{N}])(?:हजार|thousand)(?=$|[^\p{L}\p{M}\p{N}])/gui, ' 1000 '],
  [/(?:^|[^\p{L}\p{M}\p{N}])(?:पन्नास|पचास|fifty)(?=$|[^\p{L}\p{M}\p{N}])/gui, ' 50 '],
  [/(?:^|[^\p{L}\p{M}\p{N}])(?:चाळीस|चालीस|forty)(?=$|[^\p{L}\p{M}\p{N}])/gui, ' 40 '],
  [/(?:^|[^\p{L}\p{M}\p{N}])(?:तीस|thirty)(?=$|[^\p{L}\p{M}\p{N}])/gui, ' 30 '],
  [/(?:^|[^\p{L}\p{M}\p{N}])(?:पंचवीस|पच्चीस|twenty[\s-]?five)(?=$|[^\p{L}\p{M}\p{N}])/gui, ' 25 '],
  [/(?:^|[^\p{L}\p{M}\p{N}])(?:वीस|बीस|twenty)(?=$|[^\p{L}\p{M}\p{N}])/gui, ' 20 '],
  [/(?:^|[^\p{L}\p{M}\p{N}])(?:पंधरा|पंद्रह|fifteen)(?=$|[^\p{L}\p{M}\p{N}])/gui, ' 15 '],
  [/(?:^|[^\p{L}\p{M}\p{N}])(?:दहा|दस|ten)(?=$|[^\p{L}\p{M}\p{N}])/gui, ' 10 '],
  [/(?:^|[^\p{L}\p{M}\p{N}])(?:पाच|पांच|five)(?=$|[^\p{L}\p{M}\p{N}])/gui, ' 5 '],
];

export function normalizeIndicNumberWords(text: string): string {
  let result = normalizeIndicUnicode(text);
  for (const [pattern, replacement] of INDIC_NUMBER_WORDS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Detects approximate, ambiguous, or conditional quantity requests.
 * E.g., "Need around 100 kg, maybe 120 if price is lower".
 */
export function detectAmbiguousQuantityPhrasing(requestText: string): boolean {
  return (
    /\b(around|approx|approximately|maybe|or\s+\d+|लगभग|अंदाजे)\b/i.test(requestText) &&
    /\b(maybe|if\s+price|if\s+cheaper|if\s+lower|depending\s+on)\b/i.test(requestText)
  );
}

/**
 * Detects contradictory delivery schedule instructions.
 * E.g., "Deliver tomorrow, but don't schedule delivery before next week".
 */
export function detectContradictoryDeliveryPhrasing(requestText: string): boolean {
  return (
    /\b(tomorrow|today|urgent|immediately)\b/i.test(requestText) &&
    /\b(next\s+week|next\s+month|later|don't\s+schedule\s+before|not\s+before)\b/i.test(requestText)
  );
}
