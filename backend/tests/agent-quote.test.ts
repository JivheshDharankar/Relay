import { describe, it, expect } from 'vitest';
import { ProductUnit } from '@prisma/client';
import {
  QuoteInterpreter,
  QuoteInterpretInput,
  interpretationToResponseLines,
  QUOTE_TOOL_NAME,
  MockModelProvider,
  MetaModelProvider,
  ModelProvider,
} from '../src/agent';
import { isDecimalEqual, toDecimal } from '../src/domain/procurement/decimal';
import { RFQService } from '../src/discovery/supplier/rfq/RFQService';
import { SupplierResponseService } from '../src/discovery/supplier/quote/provider/SupplierResponseService';
import { QuoteNormalizationService } from '../src/discovery/supplier/quote/QuoteNormalizationService';
import { SupplierCandidate } from '../src/discovery/supplier/types';
import { SEED_IDS } from '../prisma/seed';

const SUPPLIER = { candidateId: 'cand_test_01', supplierName: 'Test Wholesaler' };

function mockInterpreter(): QuoteInterpreter {
  return new QuoteInterpreter({ provider: new MockModelProvider() });
}

function scriptedInterpreter(args: unknown): QuoteInterpreter {
  const mock = new MockModelProvider([
    {
      toolCall: {
        id: 'call_quote_scripted',
        name: QUOTE_TOOL_NAME,
        arguments: args as Record<string, unknown>,
      },
    },
  ]);
  return new QuoteInterpreter({ provider: mock });
}

function inputFor(rawResponse: string): QuoteInterpretInput {
  return { rawResponse, channel: 'manual', supplier: SUPPLIER };
}

const LIVE_ENABLED = process.env.META_LIVE_TEST === '1';

describe('Phase 14.4 — AI-assisted quote interpretation', () => {
  describe('1. Simple unit price', () => {
    it('extracts unit price with per-unit and currency evidence', async () => {
      const result = await mockInterpreter().interpret(inputFor('Sugar ₹58/kg.'));
      expect(result.status).toBe('ok');
      const item = result.interpretation?.items[0];
      expect(item?.productName).toBe('sugar');
      expect(item?.unitPrice).toBe(58);
      expect(item?.pricingUnit).toBe(ProductUnit.KG);
      expect(item?.currency).toBe('INR');
    });
  });

  describe('2. Total price', () => {
    it('keeps stated totals as totals and derives unit price deterministically', async () => {
      const raw = 'Sugar total ₹116 for 2kg.';
      const result = await scriptedInterpreter({
        items: [
          {
            productName: 'sugar',
            quantity: 2,
            unit: 'kg',
            totalPrice: 116,
            currency: 'INR',
            evidence: {
              quantity: '2kg',
              unit: '2kg',
              totalPrice: '₹116',
              currency: '₹116',
            },
          },
        ],
      }).interpret(inputFor(raw));
      expect(result.status).toBe('ok');
      const lines = interpretationToResponseLines(result.interpretation!);
      expect(lines.droppedItems).toEqual([]);
      expect(isDecimalEqual(toDecimal(lines.lineItems[0].unitPrice), toDecimal('58'))).toBe(
        true
      );
    });
  });

  describe('3. Quantity + unit', () => {
    it('extracts explicit quantity and unit', async () => {
      const result = await mockInterpreter().interpret(
        inputFor('Can supply 2 kg sugar at ₹61/kg.')
      );
      expect(result.status).toBe('ok');
      const item = result.interpretation?.items[0];
      expect(item?.quantity).toBe(2);
      expect(item?.unit).toBe(ProductUnit.KG);
      expect(item?.unitPrice).toBe(61);
    });
  });

  describe('4. MOQ', () => {
    it('extracts minimum quantity and preserves it in bridge notes', async () => {
      const result = await mockInterpreter().interpret(
        inputFor('Sugar ₹58/kg, 2 kg available, minimum 25kg.')
      );
      expect(result.status).toBe('ok');
      expect(result.interpretation?.items[0].minimumQuantity).toBe(25);
      const lines = interpretationToResponseLines(result.interpretation!);
      expect(lines.lineItems[0].notes).toContain('MOQ: 25 KG');
    });
  });

  describe('5-6. Delivery time and fee', () => {
    it('extracts explicit delivery hours and fee', async () => {
      const result = await mockInterpreter().interpret(
        inputFor('Sugar ₹58/kg, 2 kg. Delivery within 5 hours. Delivery fee ₹20.')
      );
      expect(result.status).toBe('ok');
      expect(result.interpretation?.delivery?.maxHours).toBe(5);
      expect(result.interpretation?.delivery?.deliveryFee).toBe(20);
      const lines = interpretationToResponseLines(result.interpretation!);
      expect(lines.deliveryEtaHours).toBe(5);
      expect(lines.deliveryFee).toBe(20);
    });

    it('flags vague delivery instead of inventing hours', async () => {
      const result = await mockInterpreter().interpret(
        inputFor('Sugar ₹58/kg, 2 kg. Delivery tomorrow morning.')
      );
      expect(result.status).toBe('ok');
      expect(result.interpretation?.delivery).toBeUndefined();
      expect(result.interpretation?.ambiguityFlags).toContain('DELIVERY_TIME_UNCLEAR');
    });
  });

  describe('7. Multiple products', () => {
    it('interprets three products without merging', async () => {
      const result = await mockInterpreter().interpret(
        inputFor(
          'Toothbrush ₹40 each, sugar ₹58/kg, groundnut ₹120/kg. Minimum sugar order 5kg.'
        )
      );
      expect(result.status).toBe('ok');
      expect(result.interpretation?.items.length).toBe(3);
      const byName = Object.fromEntries(
        result.interpretation!.items.map((i) => [i.productName, i])
      );
      expect(byName.toothbrush.unitPrice).toBe(40);
      expect(byName.toothbrush.pricingUnit).toBe(ProductUnit.UNIT);
      expect(byName.sugar.unitPrice).toBe(58);
      expect(byName.sugar.minimumQuantity).toBe(5);
      expect(byName.groundnut.unitPrice).toBe(120);
    });
  });

  describe('8-10. Missing information', () => {
    it('drops quantity-less items instead of guessing', async () => {
      const result = await mockInterpreter().interpret(inputFor('Sugar ₹58/kg.'));
      expect(result.status).toBe('ok');
      const lines = interpretationToResponseLines(result.interpretation!);
      expect(lines.lineItems).toEqual([]);
      expect(lines.droppedItems[0].reason).toBe('MISSING_QUANTITY');
    });

    it('drops price-less items instead of guessing', async () => {
      const result = await mockInterpreter().interpret(
        inputFor('Can supply 2 kg sugar.')
      );
      expect(result.status).toBe('ok');
      const lines = interpretationToResponseLines(result.interpretation!);
      expect(lines.droppedItems[0].reason).toBe('MISSING_PRICE');
    });

    it('leaves delivery absent when not stated', async () => {
      const result = await mockInterpreter().interpret(inputFor('Sugar ₹58/kg, 2 kg.'));
      expect(result.status).toBe('ok');
      expect(result.interpretation?.delivery).toBeUndefined();
      expect(result.interpretation?.missingFields).toContain('delivery_time');
    });
  });

  describe('11-13. Ambiguity and conflicts', () => {
    it('flags bare prices instead of assigning a per-unit', async () => {
      const result = await mockInterpreter().interpret(inputFor('Sugar ₹60.'));
      expect(result.status).toBe('ok');
      const item = result.interpretation?.items[0];
      expect(item?.unitPrice).toBeUndefined();
      expect(item?.ambiguityFlags).toContain('PRICE_UNIT_UNCLEAR');
    });

    it('flags conflicting prices and the bridge refuses them', async () => {
      const result = await mockInterpreter().interpret(
        inputFor('Sugar ₹58/kg. Total ₹150 for 2kg.')
      );
      expect(result.status).toBe('ok');
      expect(result.interpretation?.items[0].ambiguityFlags).toContain('PRICE_CONFLICT');
      const lines = interpretationToResponseLines(result.interpretation!);
      expect(lines.lineItems).toEqual([]);
      expect(lines.droppedItems[0].reason).toBe('CONFLICT_FLAGGED');
    });

    it('flags conflicting quantities', async () => {
      const result = await mockInterpreter().interpret(
        inputFor('Sugar 2kg, actually 3kg, ₹58/kg.')
      );
      expect(result.status).toBe('ok');
      expect(result.interpretation?.items[0].ambiguityFlags).toContain('QUANTITY_CONFLICT');
      const lines = interpretationToResponseLines(result.interpretation!);
      expect(lines.droppedItems[0].reason).toBe('CONFLICT_FLAGGED');
    });

    it('deterministically detects price/total mismatch even without a flag', async () => {
      const raw = 'Sugar ₹58/kg, total ₹150 for 2kg.';
      const result = await scriptedInterpreter({
        items: [
          {
            productName: 'sugar',
            quantity: 2,
            unit: 'kg',
            unitPrice: 58,
            pricingUnit: 'kg',
            totalPrice: 150,
            currency: 'INR',
            evidence: {
              quantity: '2kg',
              unit: '2kg',
              unitPrice: '₹58/kg',
              pricingUnit: '₹58/kg',
              totalPrice: '₹150',
              currency: '₹58/kg',
            },
          },
        ],
      }).interpret(inputFor(raw));
      expect(result.status).toBe('ok');
      const lines = interpretationToResponseLines(result.interpretation!);
      expect(lines.droppedItems[0].reason).toBe('PRICE_CONFLICT');
    });
  });

  describe('14-17. Fabrication is structurally impossible', () => {
    it('rejects availability fabrication', async () => {
      for (const extra of [{ inStock: true }, { availability: 'in_stock' }]) {
        const result = await scriptedInterpreter({
          items: [{ productName: 'sugar', ...extra }],
        }).interpret(inputFor('Sugar.'));
        expect(result.status).toBe('invalid');
        expect(result.issues[0].code).toBe('EXTRA_FIELD');
      }
    });

    it('rejects supplier identity fabrication', async () => {
      const byId = await scriptedInterpreter({
        items: [{ productName: 'sugar', supplierId: 'sup_1' }],
      }).interpret(inputFor('Sugar.'));
      expect(byId.status).toBe('invalid');

      const byName = await scriptedInterpreter({
        items: [{ productName: 'sugar', supplierName: 'Acme' }],
      }).interpret(inputFor('Sugar.'));
      expect(byName.status).toBe('invalid');
    });

    it('rejects reliability and discount fabrication', async () => {
      const reliability = await scriptedInterpreter({
        items: [{ productName: 'sugar', reliability: 'high', rating: 4.9 }],
      }).interpret(inputFor('Sugar.'));
      expect(reliability.status).toBe('invalid');

      const discount = await scriptedInterpreter({
        items: [{ productName: 'sugar', discount: 10, tax: 5 }],
      }).interpret(inputFor('Sugar.'));
      expect(discount.status).toBe('invalid');
    });
  });

  describe('18-19. Currency and units', () => {
    it('rejects unsupported currencies', async () => {
      const raw = 'Sugar $58/kg, USD.';
      const result = await scriptedInterpreter({
        items: [
          {
            productName: 'sugar',
            quantity: 2,
            unit: 'kg',
            unitPrice: 58,
            pricingUnit: 'kg',
            currency: 'USD',
            evidence: {
              quantity: '2',
              unit: 'kg',
              unitPrice: '$58',
              pricingUnit: 'kg',
              currency: 'USD',
            },
          },
        ],
      }).interpret(inputFor(raw));
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('UNSUPPORTED_CURRENCY');
    });

    it('rejects unsupported units', async () => {
      const raw = 'Sugar 2 BARRELS at ₹58/kg.';
      const result = await scriptedInterpreter({
        items: [
          {
            productName: 'sugar',
            quantity: 2,
            unit: 'BARRELS',
            evidence: { quantity: '2 BARRELS', unit: 'BARRELS' },
          },
        ],
      }).interpret(inputFor(raw));
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('UNSUPPORTED_UNIT');
    });
  });

  describe('20-23. Malformed output', () => {
    it('rejects extra schema fields', async () => {
      const top = await scriptedInterpreter({
        items: [{ productName: 'sugar' }],
        paymentTerms: 'net30',
      }).interpret(inputFor('Sugar.'));
      expect(top.status).toBe('invalid');
      expect(top.issues[0].code).toBe('EXTRA_FIELD');
    });

    it('rejects multiple tool calls', async () => {
      const provider: ModelProvider = {
        providerName: 'stub',
        generate: async () => {
          throw new Error('not used');
        },
        generateWithTools: async () =>
          ({
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'c1', name: QUOTE_TOOL_NAME, arguments: { items: [] } },
              { id: 'c2', name: QUOTE_TOOL_NAME, arguments: { items: [] } },
            ],
          }) as never,
      };
      const result = await new QuoteInterpreter({ provider }).interpret(
        inputFor('Sugar.')
      );
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('MULTIPLE_TOOL_CALLS');
    });

    it('rejects prose with no tool call', async () => {
      const mock = new MockModelProvider([{ content: 'Sugar costs ₹58.' }]);
      const result = await new QuoteInterpreter({ provider: mock }).interpret(
        inputFor('Sugar.')
      );
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('NO_TOOL_CALL');
    });

    it('rejects wrong-shaped arguments', async () => {
      const result = await scriptedInterpreter({ foo: 1 }).interpret(
        inputFor('Sugar.')
      );
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toMatch(/SCHEMA_VIOLATION|EXTRA_FIELD/);
    });
  });

  describe('evidence grounding', () => {
    it('rejects values without evidence and quotes absent from raw text', async () => {
      const noEvidence = await scriptedInterpreter({
        items: [
          {
            productName: 'sugar',
            quantity: 2,
            unit: 'kg',
            evidence: { quantity: '2 kg' },
          },
        ],
      }).interpret(inputFor('Sugar 2 kg.'));
      expect(noEvidence.status).toBe('invalid');
      expect(noEvidence.issues[0].code).toBe('MISSING_EVIDENCE');

      const notFound = await scriptedInterpreter({
        items: [
          {
            productName: 'sugar',
            quantity: 2,
            unit: 'kg',
            evidence: { quantity: '999 kg', unit: '999 kg' },
          },
        ],
      }).interpret(inputFor('Sugar 2 kg.'));
      expect(notFound.status).toBe('invalid');
      expect(notFound.issues[0].code).toBe('EVIDENCE_NOT_FOUND');
    });

    it('rejects unit prices without a per-unit', async () => {
      const raw = 'Sugar ₹58, 2 kg.';
      const result = await scriptedInterpreter({
        items: [
          {
            productName: 'sugar',
            quantity: 2,
            unit: 'kg',
            unitPrice: 58,
            currency: 'INR',
            evidence: {
              quantity: '2 kg',
              unit: '2 kg',
              unitPrice: '₹58',
              currency: '₹58',
            },
          },
        ],
      }).interpret(inputFor(raw));
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('INCOMPLETE_PRICE');
    });
  });

  describe('24. Decimal precision preservation', () => {
    it('derives and preserves exact decimal prices', async () => {
      const raw = 'Sugar total ₹117.95 for 2kg.';
      const result = await scriptedInterpreter({
        items: [
          {
            productName: 'sugar',
            quantity: 2,
            unit: 'kg',
            totalPrice: 117.95,
            currency: 'INR',
            evidence: {
              quantity: '2kg',
              unit: '2kg',
              totalPrice: '₹117.95',
              currency: '₹117.95',
            },
          },
        ],
      }).interpret(inputFor(raw));
      expect(result.status).toBe('ok');
      const lines = interpretationToResponseLines(result.interpretation!);
      // Derived money rounds to paise per Relay convention (58.975 -> 58.98).
      expect(
        isDecimalEqual(toDecimal(lines.lineItems[0].unitPrice), toDecimal('58.98'))
      ).toBe(true);
    });

    it('preserves stated sub-paise prices exactly without float drift', async () => {
      const raw = 'Sugar 2 kg at ₹58.975/kg.';
      const result = await scriptedInterpreter({
        items: [
          {
            productName: 'sugar',
            quantity: 2,
            unit: 'kg',
            unitPrice: 58.975,
            pricingUnit: 'kg',
            currency: 'INR',
            evidence: {
              quantity: '2 kg',
              unit: '2 kg',
              unitPrice: '₹58.975/kg',
              pricingUnit: '₹58.975/kg',
              currency: '₹58.975/kg',
            },
          },
        ],
      }).interpret(inputFor(raw));
      expect(result.status).toBe('ok');
      const lines = interpretationToResponseLines(result.interpretation!);
      expect(
        isDecimalEqual(toDecimal(lines.lineItems[0].unitPrice), toDecimal('58.975'))
      ).toBe(true);
    });
  });

  describe('25. Deterministic normalization after interpretation', () => {
    it('feeds the real normalization service into a VALID quote', async () => {
      const interpreted = await mockInterpreter().interpret(
        inputFor('Sharbati Whole Wheat Atta 20 kg at ₹45/kg. Delivery within 6 hours.')
      );
      expect(interpreted.status).toBe('ok');
      const lines = interpretationToResponseLines(interpreted.interpretation!);
      expect(lines.droppedItems).toEqual([]);
      expect(lines.lineItems.length).toBe(1);

      const candidate: SupplierCandidate = {
        id: SUPPLIER.candidateId,
        name: SUPPLIER.supplierName,
        formattedAddress: 'Market Yard, Pune',
        latitude: 18.52,
        longitude: 73.85,
        distanceKm: 3,
        distanceMeters: 3000,
        categories: ['commercial.wholesale'],
        source: 'mock',
        email: 'quotes@testwholesaler.example.com',
        phone: '+91 20 24445566',
      };
      const now = new Date();
      const rfqService = new RFQService();
      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'wheat', quantity: 20, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Community Service Area, Pune',
          quoteDeadline: new Date(now.getTime() + 2 * 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 12 * 3600 * 1000),
        },
        undefined,
        now
      );
      const responseService = new SupplierResponseService(rfqService);
      const response = await responseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: lines.lineItems,
        deliveryEtaHours: lines.deliveryEtaHours,
      });
      const normalizationService = new QuoteNormalizationService();
      const normalized = await normalizationService.normalizeResponse(response, now);
      expect(normalized.quote.status).toBe('VALID');
      expect(normalized.quote.reasons).toContain('QUOTE_VALID');
      expect(normalized.quote.subtotal).toBe(900);
      expect(normalized.quote.total).toBe(900);
      expect(normalized.quote.hasTotalMismatch).toBe(false);
      expect(normalized.quote.deliveryCommitment).toBe('CONFIRMED');
      expect(normalized.quote.currency).toBe('INR');
    });
  });

  describe('mock compatibility', () => {
    it('leaves all existing mock modes untouched', async () => {
      const mock = new MockModelProvider();
      const loop = await mock.generateWithTools({
        messages: [{ role: 'user', content: 'I need 5L cooking oil' }],
        tools: [],
      });
      expect(loop.toolCalls?.[0].name).toBe('createRequest');
    });

    it('surfaces provider errors as error status', async () => {
      const interpreter = new QuoteInterpreter({
        provider: new MetaModelProvider({ apiKey: '' }),
      });
      const result = await interpreter.interpret(inputFor('Sugar.'));
      expect(result.status).toBe('error');
      expect(result.issues[0].code).toBe('META_API_KEY_MISSING');
    });
  });

  describe('live Meta quote interpretation (config-gated)', () => {
    it.skipIf(!LIVE_ENABLED)(
      'extracts a 3-product commercial response with evidence',
      async () => {
        const interpreter = new QuoteInterpreter({
          provider: new MetaModelProvider({ timeoutMs: 30000 }),
        });
        const result = await interpreter.interpret(
          inputFor(
            'We can supply 2 toothbrushes at ₹40 each, ' +
              '2 kg sugar at ₹58/kg with minimum order 2 kg, ' +
              'and 2 kg groundnut at ₹120/kg. ' +
              'Delivery within 6 hours. Delivery fee ₹20.'
          )
        );
        expect(result.status).toBe('ok');
        expect(result.issues).toEqual([]);
        expect(result.interpretation?.items.length).toBe(3);
        const byName = Object.fromEntries(
          result.interpretation!.items.map((i) => [i.productName.toLowerCase(), i])
        );
        expect(byName.toothbrushes?.quantity ?? byName.toothbrush?.quantity).toBe(2);
        for (const item of result.interpretation!.items) {
          expect(item.quantity).toBe(2);
          expect(item.currency).toBe('INR');
          expect(item.unitPrice).toBeGreaterThan(0);
        }
        const prices = Object.fromEntries(
          result.interpretation!.items.map((i) => [i.productName.toLowerCase(), i.unitPrice])
        );
        expect(prices.toothbrush ?? prices.toothbrushes).toBe(40);
        expect(prices.sugar).toBe(58);
        expect(prices.groundnut).toBe(120);
        expect(byName.sugar.minimumQuantity).toBe(2);
        expect(result.interpretation?.delivery?.maxHours).toBeLessThanOrEqual(6);
        expect(result.interpretation?.delivery?.maxHours).toBeGreaterThan(0);
        expect(result.interpretation?.delivery?.deliveryFee).toBe(20);
        expect(result.interpretation?.supplierReference).toBeUndefined();
        const serialized = JSON.stringify(result.interpretation);
        expect(serialized).not.toMatch(
          /supplierId|supplierName|inStock|availability|rating|reliability|discount/i
        );
      },
      45000
    );
  });
});
