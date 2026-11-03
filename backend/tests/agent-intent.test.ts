import { describe, it, expect } from 'vitest';
import { ProductUnit } from '@prisma/client';
import {
  IntentExtractor,
  toParsedResidentIntents,
  INTENT_TOOL_NAME,
  MockModelProvider,
  MetaModelProvider,
  ModelProvider,
} from '../src/agent';
import { SEED_IDS } from '../prisma/seed';

function scriptedExtractor(args: unknown): IntentExtractor {
  const mock = new MockModelProvider([
    {
      toolCall: {
        id: 'call_extract_scripted',
        name: INTENT_TOOL_NAME,
        arguments: args as Record<string, unknown>,
      },
    },
  ]);
  return new IntentExtractor({ provider: mock });
}

function mockExtractor(): IntentExtractor {
  return new IntentExtractor({ provider: new MockModelProvider() });
}

function stubProvider(response: unknown): ModelProvider {
  return {
    providerName: 'stub',
    generate: async () => {
      throw new Error('not used');
    },
    generateWithTools: async () => response as never,
  };
}

const LIVE_ENABLED = process.env.META_LIVE_TEST === '1';

describe('Phase 14.2 — Structured intent + multi-item decomposition', () => {
  describe('1. Multiple items', () => {
    it('decomposes a 3-item request via mock with resolved catalog IDs', async () => {
      const result = await mockExtractor().extract(
        'I need 2 toothbrushes, 2 kg sugar and 2 kg groundnut within 12 hours under community mandate.'
      );
      expect(result.status).toBe('ok');
      expect(result.issues).toEqual([]);
      expect(result.intent?.items.length).toBe(3);
      // Generic mock emits in mention order per the tool contract
      // (toothbrush, sugar, groundnut) — same as the live model.
      expect(result.intent?.items.map((i) => i.quantity)).toEqual([2, 2, 2]);
      expect(result.intent?.items.map((i) => i.unit)).toEqual([
        ProductUnit.UNIT,
        ProductUnit.KG,
        ProductUnit.KG,
      ]);
      expect(result.intent?.items.map((i) => i.resolution)).toEqual([
        {
          status: 'resolved',
          productId: SEED_IDS.products.toothbrushes,
          canonicalName: 'toothbrush',
          identitySource: 'catalog',
        },
        {
          status: 'resolved',
          productId: SEED_IDS.products.sugar,
          canonicalName: 'sugar',
          identitySource: 'catalog',
        },
        {
          status: 'resolved',
          productId: SEED_IDS.products.groundnut,
          canonicalName: 'groundnut',
          identitySource: 'catalog',
        },
      ]);
      expect(result.intent?.deadline).toEqual({ maxHours: 12 });
      expect(result.intent?.payment).toEqual({ mandateType: 'community' });
    });
  });

  describe('2. Quantity unit variants', () => {
    it('normalizes unit aliases to the canonical execution enum', async () => {
      const result = await scriptedExtractor({
        items: [
          { productName: 'sugar', quantity: 2, unit: 'kilos' },
          { productName: 'rice', quantity: 500, unit: 'grams' },
          { productName: 'cooking oil', quantity: 2, unit: 'litres' },
          { productName: 'cooking oil', quantity: 250, unit: 'ml' },
          { productName: 'detergent', quantity: 1, unit: 'packs' },
          { productName: 'toothbrush', quantity: 2, unit: 'pieces' },
        ],
      }).extract('units probe');
      expect(result.status).toBe('ok');
      expect(result.intent?.items.map((i) => i.unit)).toEqual([
        ProductUnit.KG,
        ProductUnit.GRAM,
        ProductUnit.LITRE,
        ProductUnit.ML,
        ProductUnit.PACK,
        ProductUnit.UNIT,
      ]);
    });
  });

  describe('3-4. Deadline handling', () => {
    it('leaves deadline absent when the user stated none', async () => {
      const result = await mockExtractor().extract('I need 2 kg sugar.');
      expect(result.status).toBe('ok');
      expect(result.intent?.deadline).toBeUndefined();
    });

    it('captures an explicit 12-hour deadline', async () => {
      const result = await mockExtractor().extract(
        'I need 2 kg sugar within 12 hours.'
      );
      expect(result.status).toBe('ok');
      expect(result.intent?.deadline).toEqual({ maxHours: 12 });
    });

    it('rejects out-of-range deadlines', async () => {
      for (const maxHours of [0, -5, 721, Number.NaN]) {
        const result = await scriptedExtractor({
          items: [{ productName: 'sugar', quantity: 2, unit: 'kg' }],
          deadline: { maxHours },
        }).extract('deadline probe');
        expect(result.status).toBe('invalid');
      }
    });
  });

  describe('5-7. Quantity validation', () => {
    it('rejects non-numeric and NaN quantities', async () => {
      for (const quantity of ['two', NaN, '2']) {
        const result = await scriptedExtractor({
          items: [{ productName: 'sugar', quantity, unit: 'kg' }],
        }).extract('qty probe');
        expect(result.status).toBe('invalid');
        expect(result.issues[0].code).toBe('SCHEMA_VIOLATION');
      }
    });

    it('rejects excessive quantities', async () => {
      const result = await scriptedExtractor({
        items: [{ productName: 'sugar', quantity: 2000000, unit: 'kg' }],
      }).extract('qty probe');
      expect(result.status).toBe('invalid');
    });

    it('rejects negative quantity', async () => {
      const result = await scriptedExtractor({
        items: [{ productName: 'sugar', quantity: -3, unit: 'kg' }],
      }).extract('qty probe');
      expect(result.status).toBe('invalid');
    });

    it('rejects zero quantity', async () => {
      const result = await scriptedExtractor({
        items: [{ productName: 'sugar', quantity: 0, unit: 'kg' }],
      }).extract('qty probe');
      expect(result.status).toBe('invalid');
    });
  });

  describe('8-10. Units, names, bounds', () => {
    it('rejects unsupported units', async () => {
      const result = await scriptedExtractor({
        items: [{ productName: 'sugar', quantity: 2, unit: 'BARRELS' }],
      }).extract('unit probe');
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('UNSUPPORTED_UNIT');
    });

    it('rejects empty product names', async () => {
      const result = await scriptedExtractor({
        items: [{ productName: '', quantity: 2, unit: 'kg' }],
      }).extract('name probe');
      expect(result.status).toBe('invalid');
    });

    it('rejects excessive item counts', async () => {
      const items = Array.from({ length: 21 }, (_, i) => ({
        productName: `sugar ${i}`,
        quantity: 1,
        unit: 'kg',
      }));
      const result = await scriptedExtractor({ items }).extract('bulk probe');
      expect(result.status).toBe('invalid');
    });

    it('rejects empty item lists', async () => {
      const result = await scriptedExtractor({ items: [] }).extract('empty probe');
      expect(result.status).toBe('invalid');
    });
  });

  describe('11. Malformed model output', () => {
    it('rejects prose with no tool call', async () => {
      const mock = new MockModelProvider([{ content: 'Sure, I will order sugar.' }]);
      const result = await new IntentExtractor({ provider: mock }).extract('sugar');
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('NO_TOOL_CALL');
    });

    it('recovers from one prose response with a bounded structured retry', async () => {
      const mock = new MockModelProvider([
        { content: 'Let me think about this request.' },
        {
          toolCall: {
            id: 'call_extract_retry',
            name: INTENT_TOOL_NAME,
            arguments: { items: [{ productName: 'sugar', quantity: 2, unit: 'kg' }] },
          },
        },
      ]);
      const result = await new IntentExtractor({ provider: mock }).extract('I need 2 kg sugar.');
      expect(result.status).toBe('ok');
      expect(result.intent?.items[0]).toMatchObject({ productName: 'sugar', quantity: 2 });
    });

    it('rejects wrong-shaped tool arguments', async () => {
      const result = await scriptedExtractor({ foo: 1 }).extract('shape probe');
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toMatch(/SCHEMA_VIOLATION|EXTRA_FIELD/);
    });

    it('rejects multiple intent tool calls', async () => {
      const provider = stubProvider({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'c1', name: INTENT_TOOL_NAME, arguments: { items: [] } },
          { id: 'c2', name: INTENT_TOOL_NAME, arguments: { items: [] } },
        ],
      });
      const result = await new IntentExtractor({ provider }).extract('dup probe');
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('MULTIPLE_TOOL_CALLS');
    });
  });

  describe('12-15. Unauthorized fields can never pass validation', () => {
    it('rejects extra top-level fields', async () => {
      const result = await scriptedExtractor({
        items: [{ productName: 'sugar', quantity: 2, unit: 'kg' }],
        supplier: 'Sahyadri',
      }).extract('extra probe');
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('EXTRA_FIELD');
    });

    it('rejects extra item-level fields', async () => {
      const result = await scriptedExtractor({
        items: [{ productName: 'sugar', quantity: 2, unit: 'kg', price: 99 }],
      }).extract('extra probe');
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('EXTRA_FIELD');
    });

    it('rejects model-supplied payment amounts', async () => {
      const withAmount = await scriptedExtractor({
        items: [{ productName: 'sugar', quantity: 2, unit: 'kg' }],
        payment: { mandateType: 'community', amount: 500 },
      }).extract('payment probe');
      expect(withAmount.status).toBe('invalid');
      expect(withAmount.issues[0].code).toBe('EXTRA_FIELD');
      expect(withAmount.issues[0].message).toContain('amount');

      const topLevel = await scriptedExtractor({
        items: [{ productName: 'sugar', quantity: 2, unit: 'kg' }],
        totalAmount: 500,
      }).extract('payment probe');
      expect(topLevel.status).toBe('invalid');
    });

    it('rejects model-supplied supplier identity', async () => {
      const topLevel = await scriptedExtractor({
        items: [{ productName: 'sugar', quantity: 2, unit: 'kg' }],
        supplierId: SEED_IDS.suppliers.sahyadri,
      }).extract('supplier probe');
      expect(topLevel.status).toBe('invalid');

      const itemLevel = await scriptedExtractor({
        items: [
          { productName: 'sugar', quantity: 2, unit: 'kg', supplier: 'Sahyadri' },
        ],
      }).extract('supplier probe');
      expect(itemLevel.status).toBe('invalid');
    });

    it('rejects model authorization claims', async () => {
      const flag = await scriptedExtractor({
        items: [{ productName: 'sugar', quantity: 2, unit: 'kg' }],
        authorized: true,
      }).extract('auth probe');
      expect(flag.status).toBe('invalid');

      const nested = await scriptedExtractor({
        items: [{ productName: 'sugar', quantity: 2, unit: 'kg' }],
        authorization: { status: 'approved', limit: 99999 },
      }).extract('auth probe');
      expect(nested.status).toBe('invalid');
    });

    it('rejects fabricated product IDs', async () => {
      const result = await scriptedExtractor({
        items: [
          {
            productName: 'sugar',
            quantity: 2,
            unit: 'kg',
            productId: SEED_IDS.products.sugar,
          },
        ],
      }).extract('id probe');
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('EXTRA_FIELD');
    });
  });

  describe('16. Unmappable products fail closed', () => {
    it('reports targeted MISSING_UNIT (not wholesale unmappable) for unit-less items', async () => {
      const result = await mockExtractor().extract('I need 3 icecream.');
      expect(result.status).toBe('unresolved');
      expect(result.issues[0].code).toBe('MISSING_UNIT');
      expect(result.issues[0].itemIndex).toBe(0);
      // Partial intent is preserved for targeted clarification.
      expect(result.intent?.items).toHaveLength(1);
      expect(result.intent?.items[0].productName).toBe('icecream');
      expect(result.intent?.items[0].quantity).toBe(3);
      expect(result.intent?.items[0].resolution).toEqual({
        status: 'unresolved',
        reason: 'MISSING_UNIT',
      });
    });

    it('keeps catalog matches canonical while resolving unknown-but-valid items as open-world', async () => {
      const result = await scriptedExtractor({
        items: [
          { productName: 'sugar', quantity: 2, unit: 'kg' },
          { productName: 'icecream', quantity: 3, unit: 'packs' },
        ],
      }).extract('partial probe');
      expect(result.status).toBe('ok');
      expect(result.issues).toEqual([]);
      expect(result.intent?.items.length).toBe(2);
      expect(result.intent?.items[0].resolution).toEqual({
        status: 'resolved',
        productId: SEED_IDS.products.sugar,
        canonicalName: 'sugar',
        identitySource: 'catalog',
      });
      expect(result.intent?.items[1].resolution).toEqual({
        status: 'resolved',
        productId: null,
        canonicalName: 'icecream',
        identitySource: 'open-world',
      });
    });

    it('marks missing quantity and unit as unresolved, never guessed', async () => {
      const noQty = await scriptedExtractor({
        items: [{ productName: 'sugar', unit: 'kg' }],
      }).extract('need sugar');
      expect(noQty.status).toBe('unresolved');
      expect(noQty.issues[0].code).toBe('MISSING_QUANTITY');

      const noUnit = await scriptedExtractor({
        items: [{ productName: 'sugar', quantity: 2 }],
      }).extract('need 2 sugar');
      expect(noUnit.status).toBe('unresolved');
      expect(noUnit.issues[0].code).toBe('MISSING_UNIT');
    });

    it('resolves an explicit count of a UNIT-catalog product without a unit word', async () => {
      const result = await scriptedExtractor({
        items: [{ productName: 'toothbrushes', quantity: 2 }],
      }).extract('need 2 toothbrushes');
      expect(result.status).toBe('ok');
      expect(result.intent?.items[0].unit).toBe(ProductUnit.UNIT);
      expect(result.intent?.items[0].resolution).toEqual({
        status: 'resolved',
        productId: SEED_IDS.products.toothbrushes,
        canonicalName: 'toothbrush',
        identitySource: 'catalog',
      });
    });
  });

  describe('17. Mock provider compatibility', () => {
    it('extracts a single item through the mock', async () => {
      const result = await mockExtractor().extract('I need 5L cooking oil.');
      expect(result.status).toBe('ok');
      expect(result.intent?.items.length).toBe(1);
      expect(result.intent?.items[0].quantity).toBe(5);
      expect(result.intent?.items[0].unit).toBe(ProductUnit.LITRE);
      expect(result.intent?.items[0].resolution).toMatchObject({
        status: 'resolved',
        productId: SEED_IDS.products.cookingOil,
      });
    });

    it('leaves the default mock procurement loop untouched', async () => {
      const mock = new MockModelProvider();
      const response = await mock.generateWithTools({
        messages: [{ role: 'user', content: 'I need 5L cooking oil' }],
        tools: [],
      });
      expect(response.toolCalls?.[0].name).toBe('createRequest');
      expect(response.finishReason).toBe('tool_calls');
    });
  });

  describe('18. Meta provider structured output (mocked HTTP)', () => {
    it('extracts intent through MetaModelProvider tool calls', async () => {
      const fetchFn = (async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () =>
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: '',
                    tool_calls: [
                      {
                        id: 'call_meta_extract',
                        function: {
                          name: INTENT_TOOL_NAME,
                          arguments: JSON.stringify({
                            items: [
                              { productName: 'toothbrush', quantity: 2, unit: 'pieces' },
                              { productName: 'sugar', quantity: 2, unit: 'kg' },
                            ],
                            deadline: { maxHours: 12 },
                            payment: { mandateType: 'community' },
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
        })) as unknown as typeof fetch;
      const provider = new MetaModelProvider({
        apiKey: 'test-key',
        model: 'muse-spark-1.3',
        baseUrl: 'https://meta.test/v1',
        timeoutMs: 1000,
        fetchFn,
      });
      const result = await new IntentExtractor({ provider }).extract('meta probe');
      expect(result.status).toBe('ok');
      expect(result.intent?.items.length).toBe(2);
      expect(result.intent?.deadline).toEqual({ maxHours: 12 });
      expect(result.intent?.payment).toEqual({ mandateType: 'community' });
    });

    it('surfaces provider failures as error status without leaking', async () => {
      const provider = new MetaModelProvider({ apiKey: '' });
      const result = await new IntentExtractor({ provider }).extract('sugar');
      expect(result.status).toBe('error');
      expect(result.issues[0].code).toBe('META_API_KEY_MISSING');
    });
  });

  describe('converter + request guards', () => {
    it('converts resolved items to ParsedResidentIntent and drops unresolved', async () => {
      const result = await scriptedExtractor({
        items: [
          { productName: 'sugar', quantity: 2, unit: 'kg' },
          { productName: 'sugar', unit: 'kg' },
        ],
      }).extract('convert probe');
      expect(result.status).toBe('unresolved');
      const parsed = toParsedResidentIntents(result.intent!);
      expect(parsed.length).toBe(1);
      expect(parsed[0]).toMatchObject({
        productName: 'sugar',
        quantity: 2,
        unit: 'kg',
        isAmbiguous: false,
      });
    });

    it('rejects empty and oversized requests without calling the model', async () => {
      const empty = await mockExtractor().extract('   ');
      expect(empty.status).toBe('invalid');
      expect(empty.issues[0].code).toBe('EMPTY_REQUEST');

      const huge = await mockExtractor().extract('x'.repeat(5001));
      expect(huge.status).toBe('invalid');
      expect(huge.issues[0].code).toBe('REQUEST_TOO_LARGE');
    });
  });

  describe('19. Live Meta structured response (config-gated)', () => {
    it.skipIf(!LIVE_ENABLED)(
      'decomposes a real 3-item request with deadline and mandate',
      async () => {
        const extractor = new IntentExtractor({
          provider: new MetaModelProvider({ timeoutMs: 30000 }),
        });
        const result = await extractor.extract(
          'I need 2 toothbrushes, 2 kg sugar, and 2 kg groundnut within 12 hours under community mandate.'
        );
        expect(result.status).toBe('ok');
        expect(result.intent?.items.length).toBe(3);
        expect(result.intent?.items.map((i) => i.quantity).sort()).toEqual([2, 2, 2]);
        expect(
          result.intent?.items.map((i) => i.resolution).every((r) => r.status === 'resolved')
        ).toBe(true);
        expect(
          result.intent?.items
            .map((i) =>
              i.resolution.status === 'resolved' ? i.resolution.canonicalName : null
            )
            .sort()
        ).toEqual(['groundnut', 'sugar', 'toothbrush']);
        expect(result.intent?.deadline).toEqual({ maxHours: 12 });
        expect(result.intent?.payment).toEqual({ mandateType: 'community' });
      },
      45000
    );
  });
});
