import { ZodError } from 'zod';
import { ProductUnit } from '@prisma/client';
import { ModelProvider, ModelProviderError, getModelProvider } from '../model';
import { normalizeIntentUnit } from '../intent/intentSchema';
import { matchCatalogProduct } from '../intent/catalogMatcher';
import {
  SupplierResponseChannel,
  SupplierResponseLineItem,
} from '../../discovery/supplier/quote/types';
import {
  divideDecimals,
  isLessThanOrEqual,
  multiplyDecimals,
  roundMoney,
  subtractDecimals,
  toDecimal,
} from '../../domain/procurement/decimal';
import {
  AmbiguityFlag,
  INTERPRET_QUOTE_TOOL,
  MissingField,
  QUOTE_INTERPRETATION_SYSTEM_PROMPT,
  QUOTE_TOOL_NAME,
  RawQuoteInterpretation,
  normalizeQuoteCurrency,
  rawQuoteInterpretationSchema,
} from './quoteSchema';

export type QuoteInterpretationStatus = 'ok' | 'invalid' | 'error';

export type QuoteItemResolution =
  | { status: 'resolved'; productId: string; canonicalName: string }
  | { status: 'unresolved' };

export interface ValidatedQuoteItem {
  productName: string;
  quantity?: number;
  unit?: ProductUnit;
  unitPrice?: number;
  pricingUnit?: ProductUnit;
  totalPrice?: number;
  currency?: string;
  minimumQuantity?: number;
  resolution: QuoteItemResolution;
  constraints: string[];
  notes: string[];
  ambiguityFlags: AmbiguityFlag[];
  missingFields: MissingField[];
}

export interface ValidatedQuoteInterpretation {
  supplierReference?: string;
  items: ValidatedQuoteItem[];
  delivery?: { maxHours?: number; deliveryFee?: number };
  constraints: string[];
  notes: string[];
  ambiguityFlags: AmbiguityFlag[];
  missingFields: MissingField[];
  confidence?: number;
}

export interface QuoteInterpretationIssue {
  code: string;
  message: string;
  itemIndex?: number;
}

export interface QuoteInterpretationResult {
  status: QuoteInterpretationStatus;
  interpretation?: ValidatedQuoteInterpretation;
  issues: QuoteInterpretationIssue[];
}

export interface QuoteInterpretInput {
  rawResponse: string;
  channel: SupplierResponseChannel;
  supplier: { candidateId: string; supplierName: string };
}

export interface DroppedInterpretedItem {
  index: number;
  reason: string;
  detail: string;
}

export interface InterpretedResponseLines {
  lineItems: SupplierResponseLineItem[];
  deliveryFee?: number;
  deliveryEtaHours?: number;
  droppedItems: DroppedInterpretedItem[];
}

const MAX_RAW_CHARS = 5000;
const CHANNELS: SupplierResponseChannel[] = ['email', 'portal', 'api', 'webhook', 'manual'];

function normalizeEvidenceText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function evidenceGrounded(rawResponse: string, quote: string): boolean {
  const normalizedQuote = normalizeEvidenceText(quote);
  if (normalizedQuote.length === 0) return false;
  return normalizeEvidenceText(rawResponse).includes(normalizedQuote);
}

function mapZodIssues(error: ZodError): QuoteInterpretationIssue[] {
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
        message: `Quote interpretation contains unauthorized field(s) at ${path || 'root'}: ${issue.keys.join(', ')}`,
        itemIndex,
      };
    }
    return {
      code: 'SCHEMA_VIOLATION',
      message: `Quote interpretation failed validation at ${path || 'root'}: ${issue.message}`,
      itemIndex,
    };
  });
}

/**
 * Phase 14.4 — deterministic quote-interpretation service.
 *
 * Flow: raw supplier text (+ Relay-owned supplier/channel context) → model
 * proposes structured commercial facts with verbatim evidence → strict zod
 * validation → deterministic evidence grounding, unit/currency normalization
 * → validated interpretation. The bridge below then converts complete items
 * into normalization-ready line items using Decimal-safe math only.
 */
export class QuoteInterpreter {
  private provider: ModelProvider;

  constructor(options?: { provider?: ModelProvider }) {
    this.provider = options?.provider ?? getModelProvider();
  }

  public async interpret(input: QuoteInterpretInput): Promise<QuoteInterpretationResult> {
    const { rawResponse } = input;
    if (!rawResponse || rawResponse.trim().length === 0) {
      return {
        status: 'invalid',
        issues: [{ code: 'EMPTY_RESPONSE', message: 'Supplier response is empty.' }],
      };
    }
    if (rawResponse.length > MAX_RAW_CHARS) {
      return {
        status: 'invalid',
        issues: [
          {
            code: 'RESPONSE_TOO_LARGE',
            message: `Supplier response exceeds ${MAX_RAW_CHARS} characters.`,
          },
        ],
      };
    }
    if (!CHANNELS.includes(input.channel)) {
      return {
        status: 'invalid',
        issues: [{ code: 'INVALID_CHANNEL', message: 'Unknown supplier channel.' }],
      };
    }

    let response;
    try {
      response = await this.provider.generateWithTools({
        messages: [
          { role: 'system', content: QUOTE_INTERPRETATION_SYSTEM_PROMPT },
          { role: 'user', content: this.renderPrompt(input) },
        ],
        tools: [INTERPRET_QUOTE_TOOL],
        temperature: 0.1,
        // Evidence-grounded multi-item extraction reasons heavily (observed:
        // ~650 reasoning tokens for a single item); the budget must leave room
        // for reasoning plus the emitted tool call or the model stops with
        // finish_reason=length and no tool call.
        maxTokens: 4096,
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

    const calls = (response.toolCalls ?? []).filter((c) => c.name === QUOTE_TOOL_NAME);
    if (calls.length === 0) {
      return {
        status: 'invalid',
        issues: [
          {
            code: 'NO_TOOL_CALL',
            message: 'Model did not return a quote-interpretation tool call.',
          },
        ],
      };
    }
    if (calls.length > 1) {
      return {
        status: 'invalid',
        issues: [
          {
            code: 'MULTIPLE_TOOL_CALLS',
            message: 'Model returned more than one interpretation tool call.',
          },
        ],
      };
    }

    const parsed = rawQuoteInterpretationSchema.safeParse(calls[0].arguments);
    if (!parsed.success) {
      return { status: 'invalid', issues: mapZodIssues(parsed.error) };
    }
    return this.validateInterpretation(parsed.data, rawResponse);
  }

  private renderPrompt(input: QuoteInterpretInput): string {
    return (
      `Supplier context (authoritative, supplied by Relay — never infer identity):\n` +
      `candidateId: ${input.supplier.candidateId}\n` +
      `supplierName: ${input.supplier.supplierName}\n` +
      `channel: ${input.channel}\n\n` +
      `Supplier raw response:\n"""\n${input.rawResponse}\n"""\n\n` +
      'Call interpret_supplier_quote now with the structured interpretation.'
    );
  }

  private requireEvidence(
    rawResponse: string,
    quote: string | undefined,
    label: string,
    itemIndex: number | undefined,
    issues: QuoteInterpretationIssue[]
  ): boolean {
    if (quote === undefined) {
      issues.push({
        code: 'MISSING_EVIDENCE',
        message: `${label} has no verbatim evidence quote.`,
        itemIndex,
      });
      return false;
    }
    if (!evidenceGrounded(rawResponse, quote)) {
      issues.push({
        code: 'EVIDENCE_NOT_FOUND',
        message: `${label} evidence quote does not appear in the supplier response.`,
        itemIndex,
      });
      return false;
    }
    return true;
  }

  private validateInterpretation(
    raw: RawQuoteInterpretation,
    rawResponse: string
  ): QuoteInterpretationResult {
    const issues: QuoteInterpretationIssue[] = [];
    const items: ValidatedQuoteItem[] = [];

    raw.items.forEach((item, index) => {
      const evidence = item.evidence ?? {};
      let itemValid = true;
      const fail = (code: string, message: string) => {
        issues.push({ code, message, itemIndex: index });
        itemValid = false;
      };

      let unit: ProductUnit | undefined;
      if (item.unit !== undefined) {
        const normalized = normalizeIntentUnit(item.unit);
        if (!normalized) {
          fail('UNSUPPORTED_UNIT', `Item ${index} uses unsupported unit "${item.unit}".`);
        } else {
          unit = normalized;
        }
        if (!this.requireEvidence(rawResponse, evidence.unit, `Item ${index} unit`, index, issues)) {
          itemValid = false;
        }
      }

      let pricingUnit: ProductUnit | undefined;
      if (item.pricingUnit !== undefined) {
        const normalized = normalizeIntentUnit(item.pricingUnit);
        if (!normalized) {
          fail(
            'UNSUPPORTED_UNIT',
            `Item ${index} uses unsupported pricing unit "${item.pricingUnit}".`
          );
        } else {
          pricingUnit = normalized;
        }
        if (
          !this.requireEvidence(rawResponse, evidence.pricingUnit, `Item ${index} pricing unit`, index, issues)
        ) {
          itemValid = false;
        }
      }

      if (item.unitPrice !== undefined && item.pricingUnit === undefined) {
        fail(
          'INCOMPLETE_PRICE',
          `Item ${index} states a unit price without its per-unit. Flag PRICE_UNIT_UNCLEAR instead.`
        );
      }

      let currency: string | undefined;
      if (item.currency !== undefined) {
        const normalized = normalizeQuoteCurrency(item.currency);
        if (!normalized) {
          fail(
            'UNSUPPORTED_CURRENCY',
            `Item ${index} uses unsupported currency "${item.currency}".`
          );
        } else {
          currency = normalized;
        }
        if (
          !this.requireEvidence(rawResponse, evidence.currency, `Item ${index} currency`, index, issues)
        ) {
          itemValid = false;
        }
      }

      if (item.quantity !== undefined) {
        if (
          !this.requireEvidence(rawResponse, evidence.quantity, `Item ${index} quantity`, index, issues)
        ) {
          itemValid = false;
        }
      }
      if (item.unitPrice !== undefined) {
        if (
          !this.requireEvidence(rawResponse, evidence.unitPrice, `Item ${index} unit price`, index, issues)
        ) {
          itemValid = false;
        }
      }
      if (item.totalPrice !== undefined) {
        if (
          !this.requireEvidence(rawResponse, evidence.totalPrice, `Item ${index} total price`, index, issues)
        ) {
          itemValid = false;
        }
      }
      if (item.minimumQuantity !== undefined) {
        if (
          !this.requireEvidence(
            rawResponse,
            evidence.minimumQuantity,
            `Item ${index} minimum quantity`,
            index,
            issues
          )
        ) {
          itemValid = false;
        }
      }

      if (!itemValid) {
        return;
      }
      const match = matchCatalogProduct(item.productName);
      items.push({
        productName: item.productName.trim(),
        quantity: item.quantity,
        unit,
        unitPrice: item.unitPrice,
        pricingUnit,
        totalPrice: item.totalPrice,
        currency,
        minimumQuantity: item.minimumQuantity,
        resolution: match
          ? { status: 'resolved', productId: match.productId, canonicalName: match.canonicalName }
          : { status: 'unresolved' },
        constraints: item.constraints ?? [],
        notes: item.notes ?? [],
        ambiguityFlags: item.ambiguityFlags ?? [],
        missingFields: item.missingFields ?? [],
      });
    });

    let delivery: { maxHours?: number; deliveryFee?: number } | undefined;
    if (raw.delivery) {
      const evidence = raw.delivery.evidence ?? {};
      let deliveryValid = true;
      if (raw.delivery.maxHours !== undefined) {
        if (
          !this.requireEvidence(rawResponse, evidence.maxHours, 'Delivery time', undefined, issues)
        ) {
          deliveryValid = false;
        }
      }
      if (raw.delivery.deliveryFee !== undefined) {
        if (
          !this.requireEvidence(rawResponse, evidence.deliveryFee, 'Delivery fee', undefined, issues)
        ) {
          deliveryValid = false;
        }
      }
      if (!deliveryValid) {
        return { status: 'invalid', issues };
      }
      delivery = { maxHours: raw.delivery.maxHours, deliveryFee: raw.delivery.deliveryFee };
    }

    if (issues.length > 0) {
      return { status: 'invalid', issues };
    }
    return {
      status: 'ok',
      interpretation: {
        supplierReference: raw.supplierReference,
        items,
        delivery,
        constraints: raw.constraints ?? [],
        notes: raw.notes ?? [],
        ambiguityFlags: raw.ambiguityFlags ?? [],
        missingFields: raw.missingFields ?? [],
        confidence: raw.confidence,
      },
      issues: [],
    };
  }
}

/**
 * Deterministically converts a validated interpretation into
 * normalization-ready supplier line items. Incomplete items are dropped with
 * explicit reasons — never defaulted. All arithmetic is Decimal-safe; the
 * model performs no financial math.
 */
export function interpretationToResponseLines(
  interpretation: ValidatedQuoteInterpretation
): InterpretedResponseLines {
  const lineItems: SupplierResponseLineItem[] = [];
  const droppedItems: DroppedInterpretedItem[] = [];

  interpretation.items.forEach((item, index) => {
    const drop = (reason: string, detail: string) => {
      droppedItems.push({ index, reason, detail });
    };

    if (
      item.ambiguityFlags.includes('PRICE_CONFLICT') ||
      item.ambiguityFlags.includes('QUANTITY_CONFLICT')
    ) {
      drop('CONFLICT_FLAGGED', `Item ${index} carries an unresolved conflict flag.`);
      return;
    }
    if (item.quantity === undefined || item.unit === undefined) {
      drop(
        item.quantity === undefined ? 'MISSING_QUANTITY' : 'MISSING_UNIT',
        `Item ${index} lacks an explicit quantity or unit.`
      );
      return;
    }
    if (item.unitPrice === undefined && item.totalPrice === undefined) {
      drop('MISSING_PRICE', `Item ${index} states no usable price.`);
      return;
    }
    if (item.currency === undefined) {
      drop('CURRENCY_UNKNOWN', `Item ${index} states a price without usable currency.`);
      return;
    }

    let unitPrice: number;
    if (item.unitPrice !== undefined && item.totalPrice !== undefined) {
      const expected = multiplyDecimals(item.unitPrice, item.quantity);
      const diff = subtractDecimals(toDecimal(item.totalPrice), expected).abs();
      if (!isLessThanOrEqual(diff, toDecimal('0.01'))) {
        drop(
          'PRICE_CONFLICT',
          `Item ${index} unit price and total price disagree deterministically.`
        );
        return;
      }
      unitPrice = item.unitPrice;
    } else if (item.unitPrice !== undefined) {
      if (item.pricingUnit !== item.unit) {
        drop(
          'PRICING_UNIT_MISMATCH',
          `Item ${index} is priced per ${item.pricingUnit} but quoted in ${item.unit}.`
        );
        return;
      }
      unitPrice = item.unitPrice;
    } else {
      unitPrice = roundMoney(divideDecimals(item.totalPrice as number, item.quantity)).toNumber();
    }

    const notes: string[] = [...item.notes];
    if (item.minimumQuantity !== undefined) {
      notes.push(`MOQ: ${toDecimal(item.minimumQuantity).toString()} ${item.unit}`);
    }
    lineItems.push({
      productId:
        item.resolution.status === 'resolved' ? item.resolution.productId : undefined,
      productName: item.productName,
      quotedQuantity: item.quantity,
      unit: item.unit,
      unitPrice,
      notes: notes.length > 0 ? notes.join('; ') : undefined,
    });
  });

  return {
    lineItems,
    deliveryFee: interpretation.delivery?.deliveryFee,
    deliveryEtaHours: interpretation.delivery?.maxHours,
    droppedItems,
  };
}
