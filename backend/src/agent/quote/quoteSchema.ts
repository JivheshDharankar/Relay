import { z } from 'zod';
import { ToolDefinition } from '../model/types';

/**
 * Phase 14.4 — AI quote-interpretation contract.
 *
 * Meta reads a messy supplier response and proposes structured commercial
 * facts. Every interpreted number must carry a verbatim evidence quote from
 * the raw response, which Relay verifies deterministically. The model can
 * never supply supplier identity, availability, reliability, discounts, tax,
 * or payment terms: the strict schemas below have no such fields.
 */

export const QUOTE_TOOL_NAME = 'interpret_supplier_quote';

export const MAX_QUOTE_ITEMS = 10;
export const MAX_QUOTE_QUANTITY = 1000000;
export const MAX_MONEY = 1000000000;
export const MAX_QUOTE_DEADLINE_HOURS = 720;
export const MAX_QUOTE_PRODUCT_NAME_LENGTH = 120;
export const MAX_EVIDENCE_LENGTH = 200;

export const SUPPORTED_CURRENCIES = ['INR'] as const;

export const AMBIGUITY_FLAGS = [
  'PRICE_UNIT_UNCLEAR',
  'PRICE_TYPE_UNCLEAR',
  'QUANTITY_UNCLEAR',
  'UNIT_UNCLEAR',
  'DELIVERY_TIME_UNCLEAR',
  'DELIVERY_FEE_UNCLEAR',
  'CURRENCY_UNCLEAR',
  'PRICE_CONFLICT',
  'QUANTITY_CONFLICT',
  'PRODUCT_UNCLEAR',
  'OTHER_AMBIGUITY',
] as const;
export type AmbiguityFlag = (typeof AMBIGUITY_FLAGS)[number];

export const MISSING_FIELDS = [
  'quantity',
  'unit',
  'unit_price',
  'total_price',
  'currency',
  'delivery_time',
  'delivery_fee',
  'minimum_quantity',
  'product',
] as const;
export type MissingField = (typeof MISSING_FIELDS)[number];

const evidenceSchema = z
  .object({
    quantity: z.string().min(1).max(MAX_EVIDENCE_LENGTH).optional(),
    unit: z.string().min(1).max(MAX_EVIDENCE_LENGTH).optional(),
    unitPrice: z.string().min(1).max(MAX_EVIDENCE_LENGTH).optional(),
    pricingUnit: z.string().min(1).max(MAX_EVIDENCE_LENGTH).optional(),
    totalPrice: z.string().min(1).max(MAX_EVIDENCE_LENGTH).optional(),
    minimumQuantity: z.string().min(1).max(MAX_EVIDENCE_LENGTH).optional(),
    currency: z.string().min(1).max(MAX_EVIDENCE_LENGTH).optional(),
  })
  .strict();

const rawQuoteItemSchema = z
  .object({
    productName: z.string().min(1).max(MAX_QUOTE_PRODUCT_NAME_LENGTH),
    quantity: z.number().finite().positive().max(MAX_QUOTE_QUANTITY).optional(),
    unit: z.string().min(1).max(40).optional(),
    unitPrice: z.number().finite().min(0).max(MAX_MONEY).optional(),
    pricingUnit: z.string().min(1).max(40).optional(),
    totalPrice: z.number().finite().min(0).max(MAX_MONEY).optional(),
    currency: z.string().min(1).max(16).optional(),
    minimumQuantity: z.number().finite().positive().max(MAX_QUOTE_QUANTITY).optional(),
    evidence: evidenceSchema.optional(),
    constraints: z.array(z.string().min(1).max(120)).max(10).optional(),
    notes: z.array(z.string().min(1).max(500)).max(10).optional(),
    ambiguityFlags: z.array(z.enum(AMBIGUITY_FLAGS)).max(10).optional(),
    missingFields: z.array(z.enum(MISSING_FIELDS)).max(10).optional(),
  })
  .strict();

const rawQuoteDeliverySchema = z
  .object({
    maxHours: z.number().finite().positive().max(MAX_QUOTE_DEADLINE_HOURS).optional(),
    deliveryFee: z.number().finite().min(0).max(MAX_MONEY).optional(),
    evidence: z
      .object({
        maxHours: z.string().min(1).max(MAX_EVIDENCE_LENGTH).optional(),
        deliveryFee: z.string().min(1).max(MAX_EVIDENCE_LENGTH).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const rawQuoteInterpretationSchema = z
  .object({
    supplierReference: z.string().min(1).max(64).optional(),
    items: z.array(rawQuoteItemSchema).min(1).max(MAX_QUOTE_ITEMS),
    delivery: rawQuoteDeliverySchema.optional(),
    constraints: z.array(z.string().min(1).max(120)).max(10).optional(),
    notes: z.array(z.string().min(1).max(500)).max(10).optional(),
    ambiguityFlags: z.array(z.enum(AMBIGUITY_FLAGS)).max(10).optional(),
    missingFields: z.array(z.enum(MISSING_FIELDS)).max(10).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export type RawQuoteItem = z.infer<typeof rawQuoteItemSchema>;
export type RawQuoteInterpretation = z.infer<typeof rawQuoteInterpretationSchema>;

/**
 * Normalizes a proposed currency to ISO form. Returns null when Relay cannot
 * represent it. Relay transacts in INR; anything else fails closed.
 */
export function normalizeQuoteCurrency(raw: string): string | null {
  const cleaned = raw.trim();
  if (cleaned === '₹') return 'INR';
  const upper = cleaned.toUpperCase();
  if (upper === 'RS' || upper === 'RS.' || upper === 'RUPEE' || upper === 'RUPEES') {
    return 'INR';
  }
  if (/^[A-Z]{3}$/.test(upper) && (SUPPORTED_CURRENCIES as readonly string[]).includes(upper)) {
    return upper;
  }
  return null;
}

/**
 * Inference-only tool definition for quote interpretation.
 * Deliberately NOT registered in the executable ToolRegistry.
 */
export const INTERPRET_QUOTE_TOOL: ToolDefinition = {
  name: QUOTE_TOOL_NAME,
  description:
    'Interpret a raw supplier response into structured commercial facts with verbatim evidence. Call exactly once.',
  parameters: {
    type: 'object',
    properties: {
      supplierReference: {
        type: 'string',
        description: 'Supplier quote/reference number, only if explicitly stated.',
      },
      items: {
        type: 'array',
        description: 'One entry per distinct quoted product. Use these exact field names.',
        items: {
          type: 'object',
          properties: {
            productName: { type: 'string', description: 'Product name as stated.' },
            quantity: { type: 'number', description: 'Explicit quantity, else omit.' },
            unit: { type: 'string', description: 'Unit/count word as stated, else omit.' },
            unitPrice: { type: 'number', description: 'Per-unit price, requires pricingUnit.' },
            pricingUnit: { type: 'string', description: 'Per-unit the unitPrice applies to.' },
            totalPrice: { type: 'number', description: 'Stated total price, else omit.' },
            currency: { type: 'string', description: 'INR when explicitly stated.' },
            minimumQuantity: { type: 'number', description: 'Stated MOQ, else omit.' },
            evidence: {
              type: 'object',
              description: 'Verbatim evidence quotes copied from the message.',
              properties: {
                quantity: { type: 'string' },
                unit: { type: 'string' },
                unitPrice: { type: 'string' },
                pricingUnit: { type: 'string' },
                totalPrice: { type: 'string' },
                minimumQuantity: { type: 'string' },
                currency: { type: 'string' },
              },
            },
            constraints: { type: 'array', items: { type: 'string' } },
            notes: { type: 'array', items: { type: 'string' } },
            ambiguityFlags: { type: 'array', items: { type: 'string' } },
            missingFields: { type: 'array', items: { type: 'string' } },
          },
          required: ['productName'],
        },
      },
      delivery: {
        type: 'object',
        description: 'Delivery time/fee, only if explicitly stated.',
        properties: {
          maxHours: { type: 'number' },
          deliveryFee: { type: 'number' },
          evidence: {
            type: 'object',
            properties: {
              maxHours: { type: 'string' },
              deliveryFee: { type: 'string' },
            },
          },
        },
      },
      constraints: { type: 'array', items: { type: 'string' } },
      notes: { type: 'array', items: { type: 'string' } },
      ambiguityFlags: { type: 'array', items: { type: 'string' } },
      missingFields: { type: 'array', items: { type: 'string' } },
    },
    required: ['items'],
  },
};

export const QUOTE_INTERPRETATION_SYSTEM_PROMPT = [
  'You interpret raw supplier responses for the Relay procurement platform.',
  'You receive supplier context plus the verbatim supplier message. You MUST call interpret_supplier_quote exactly once and MUST NOT reply in prose.',
  'Rules:',
  '1. Extract ONLY explicitly stated commercial facts. Never invent prices, quantities, MOQs, delivery times, fees, currency, availability, reliability, discounts, tax, or stock.',
  '2. Every interpreted number MUST carry a verbatim evidence quote copied exactly from the supplier message (evidence.quantity, evidence.unitPrice, evidence.totalPrice, evidence.minimumQuantity, evidence.maxHours, evidence.deliveryFee, and evidence for unit/pricingUnit/currency when those are set). A value without evidence is rejected.',
  '3. Quantities: JSON numbers only; convert word numbers ("two" -> 2). Omit quantity/unit when not stated.',
  '4. unit: normalize to a unit word (kg, grams, litres, ml, packs, pieces, each). For explicit counts of a product ("2 toothbrushes"), use "pieces" with the count phrase as evidence. Never use the product name itself as the unit. Same for pricingUnit ("Rs 40 each" -> pricingUnit "each").',
  '5. Prices: "Rs58/kg" or "Rs 58 per kg" means unitPrice 58 with pricingUnit kg and currency INR. "Rs 116 for 2kg" means totalPrice 116, NOT unitPrice. A bare "Rs 60" with no per-unit or total context is ambiguous: omit the price and flag PRICE_UNIT_UNCLEAR.',
  '6. unitPrice REQUIRES pricingUnit. Never attach a unit price without its per-unit.',
  '7. Currency: the Rs symbol, "Rs", or "rupees" means INR. Any other currency is unsupported: omit it and flag CURRENCY_UNCLEAR.',
  '8. Delivery: "within 6 hours" means maxHours 6. Vague phrases ("tomorrow morning", "soon", "local supplier") are NOT hours: omit maxHours and flag DELIVERY_TIME_UNCLEAR. Never infer time from geography.',
  '9. Conflicts ("Rs58/kg but Rs 150 total for 2kg"): include both values and flag PRICE_CONFLICT. Do not choose silently.',
  '10. One item per distinct product. Never merge products or quantities.',
  '11. NEVER output supplier IDs, supplier names, addresses, phones, availability, reliability, ratings, payment terms, discounts, tax, stock, or invoice numbers. Supplier identity comes from Relay context, never from you.',
].join('\n');
