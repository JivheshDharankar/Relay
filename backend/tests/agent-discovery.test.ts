import { describe, it, expect } from 'vitest';
import { ProductUnit } from '@prisma/client';
import {
  DiscoveryPlanner,
  DiscoveryPlanError,
  buildDiscoveryQueries,
  validateDiscoveryCategory,
  normalizeSupplierType,
  DISCOVERY_TOOL_NAME,
  DEFAULT_DISCOVERY_RADIUS_KM,
  MAX_DISCOVERY_RADIUS_KM,
  IntentExtractor,
  ValidatedIntent,
  MockModelProvider,
  MetaModelProvider,
  ModelProvider,
} from '../src/agent';
import { MockSupplierDiscoveryProvider } from '../src/discovery/supplier/MockSupplierDiscoveryProvider';
import { SEED_IDS } from '../prisma/seed';

function resolvedItem(
  productId: string,
  canonicalName: string,
  quantity: number,
  unit: ProductUnit
) {
  return {
    productName: canonicalName,
    quantity,
    unit,
    constraints: [],
    resolution: { status: 'resolved' as const, productId, canonicalName },
  };
}

function testIntent(withDeadline = true): ValidatedIntent {
  return {
    originalRequest: 'I need 2 toothbrushes, 2 kg sugar and 2 kg groundnut.',
    items: [
      resolvedItem(SEED_IDS.products.toothbrushes, 'toothbrush', 2, ProductUnit.UNIT),
      resolvedItem(SEED_IDS.products.sugar, 'sugar', 2, ProductUnit.KG),
      resolvedItem(SEED_IDS.products.groundnut, 'groundnut', 2, ProductUnit.KG),
    ],
    deadline: withDeadline ? { maxHours: 12 } : undefined,
    payment: { mandateType: 'community' as const },
  };
}

function singleItemIntent(): ValidatedIntent {
  return {
    originalRequest: 'I need 2 kg sugar.',
    items: [resolvedItem(SEED_IDS.products.sugar, 'sugar', 2, ProductUnit.KG)],
    deadline: { maxHours: 12 },
  };
}

function scriptedPlanner(args: unknown): DiscoveryPlanner {
  const mock = new MockModelProvider([
    {
      toolCall: {
        id: 'call_plan_scripted',
        name: DISCOVERY_TOOL_NAME,
        arguments: args as Record<string, unknown>,
      },
    },
  ]);
  return new DiscoveryPlanner({ provider: mock });
}

function mockPlanner(): DiscoveryPlanner {
  return new DiscoveryPlanner({ provider: new MockModelProvider() });
}

function validPlanItems() {
  return [
    {
      productId: SEED_IDS.products.toothbrushes,
      productName: 'toothbrush',
      quantity: 2,
      unit: 'UNIT',
      searchTerms: ['toothbrush', 'toothbrush retail'],
      categories: ['commercial.supermarket', 'commercial.chemist'],
      supplierTypes: ['retail', 'chemist'],
    },
    {
      productId: SEED_IDS.products.sugar,
      productName: 'sugar',
      quantity: 2,
      unit: 'KG',
      searchTerms: ['sugar', 'sugar wholesale'],
      categories: ['commercial.supermarket', 'commercial.wholesale'],
      supplierTypes: ['wholesale', 'retail'],
    },
    {
      productId: SEED_IDS.products.groundnut,
      productName: 'groundnut',
      quantity: 2,
      unit: 'KG',
      searchTerms: ['groundnut', 'peanut wholesale'],
      categories: ['commercial.marketplace', 'commercial.wholesale'],
      supplierTypes: ['wholesale', 'market'],
    },
  ];
}

const LIVE_ENABLED = process.env.META_LIVE_TEST === '1';

describe('Phase 14.3 — AI discovery planning', () => {
  describe('1-2. Single and multi-item plans (mock)', () => {
    it('plans a single item deterministically', async () => {
      const result = await mockPlanner().plan(singleItemIntent());
      expect(result.status).toBe('ok');
      expect(result.plan?.items.length).toBe(1);
      const item = result.plan?.items[0];
      expect(item?.productId).toBe(SEED_IDS.products.sugar);
      expect(item?.quantity).toBe(2);
      expect(item?.unit).toBe(ProductUnit.KG);
      expect(item?.searchTerms.length).toBeGreaterThan(0);
      expect(item?.categories.length).toBeGreaterThan(0);
      expect(item?.supplierTypes.length).toBeGreaterThan(0);
      expect(result.plan?.fulfillment).toEqual({ maxHours: 12 });
    });

    it('plans three items without merging or inventing products', async () => {
      const result = await mockPlanner().plan(testIntent());
      expect(result.status).toBe('ok');
      expect(result.plan?.items.map((i) => i.productId).sort()).toEqual(
        [
          SEED_IDS.products.toothbrushes,
          SEED_IDS.products.sugar,
          SEED_IDS.products.groundnut,
        ].sort()
      );
      expect(result.plan?.items.map((i) => i.quantity)).toEqual([2, 2, 2]);
    });

    it('chains Phase 14.2 extraction into Phase 14.3 planning', async () => {
      const intent = await new IntentExtractor({
        provider: new MockModelProvider(),
      }).extract('I need 2 toothbrushes, 2 kg sugar and 2 kg groundnut within 12 hours.');
      expect(intent.status).toBe('ok');
      const planned = await mockPlanner().plan(intent.intent!);
      expect(planned.status).toBe('ok');
      expect(planned.plan?.items.length).toBe(3);
    });
  });

  describe('3-4. Search terms and category vocabulary', () => {
    it('mock search terms are non-empty and bounded', async () => {
      const result = await mockPlanner().plan(testIntent());
      expect(result.status).toBe('ok');
      for (const item of result.plan!.items) {
        expect(item.searchTerms.length).toBeGreaterThanOrEqual(1);
        expect(item.searchTerms.length).toBeLessThanOrEqual(8);
        for (const term of item.searchTerms) {
          expect(term.trim().length).toBeGreaterThan(0);
          expect(term.length).toBeLessThanOrEqual(80);
        }
      }
    });

    it('validates categories against Relay vocabulary', () => {
      expect(validateDiscoveryCategory('commercial.supermarket').valid).toBe(true);
      expect(validateDiscoveryCategory('commercial.wholesale').valid).toBe(true);
      expect(validateDiscoveryCategory('commercial.chemist').valid).toBe(true);
      expect(validateDiscoveryCategory('commercial.cinema').valid).toBe(false);
      expect(validateDiscoveryCategory('commercial').valid).toBe(false);
      expect(validateDiscoveryCategory('not a category!!').valid).toBe(false);
    });

    it('normalizes supplier types against supported vocabulary', () => {
      expect(normalizeSupplierType('Wholesale')).toBe('wholesale');
      expect(normalizeSupplierType('General Store')).toBe('general_store');
      expect(normalizeSupplierType('black market')).toBeNull();
    });
  });

  describe('5. Unsupported category', () => {
    it('rejects incompatible business categories', async () => {
      const items = validPlanItems();
      items[1].categories = ['commercial.cinema'];
      const result = await scriptedPlanner({ items }).plan(testIntent());
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('UNSUPPORTED_CATEGORY');
    });

    it('rejects unknown supplier types', async () => {
      const items = validPlanItems();
      items[0].supplierTypes = ['smuggler'];
      const result = await scriptedPlanner({ items }).plan(testIntent());
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('UNSUPPORTED_SUPPLIER_TYPE');
    });
  });

  describe('6-7. Quantity and unit tampering', () => {
    it('rejects changed quantities', async () => {
      const items = validPlanItems();
      items[1].quantity = 1;
      const result = await scriptedPlanner({ items }).plan(testIntent());
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('QUANTITY_TAMPERED');
    });

    it('rejects changed units', async () => {
      const items = validPlanItems();
      items[1].unit = 'GRAM';
      const result = await scriptedPlanner({ items }).plan(testIntent());
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('UNIT_TAMPERED');
    });
  });

  describe('8. Deadline protection', () => {
    it('rejects deadline expansion', async () => {
      const result = await scriptedPlanner({
        items: validPlanItems(),
        fulfillment: { maxHours: 24 },
      }).plan(testIntent());
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('DEADLINE_EXPANDED');
    });

    it('allows deadline tightening and inherits when omitted', async () => {
      const tightened = await scriptedPlanner({
        items: validPlanItems(),
        fulfillment: { maxHours: 10 },
      }).plan(testIntent());
      expect(tightened.status).toBe('ok');
      expect(tightened.plan?.fulfillment).toEqual({ maxHours: 10 });

      const inherited = await scriptedPlanner({ items: validPlanItems() }).plan(
        testIntent()
      );
      expect(inherited.status).toBe('ok');
      expect(inherited.plan?.fulfillment).toEqual({ maxHours: 12 });
    });

    it('rejects invented deadlines', async () => {
      const result = await scriptedPlanner({
        items: validPlanItems(),
        fulfillment: { maxHours: 12 },
      }).plan(testIntent(false));
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('INVENTED_DEADLINE');
    });
  });

  describe('9. Radius protection', () => {
    it('rejects excessive radius and defaults when omitted', async () => {
      const excessive = await scriptedPlanner({
        items: validPlanItems(),
        geography: { radiusKm: 50 },
      }).plan(testIntent());
      expect(excessive.status).toBe('invalid');
      expect(excessive.issues[0].code).toBe('RADIUS_EXCEEDED');

      const omitted = await scriptedPlanner({ items: validPlanItems() }).plan(
        testIntent()
      );
      expect(omitted.status).toBe('ok');
      expect(omitted.plan?.geography.radiusKm).toBe(DEFAULT_DISCOVERY_RADIUS_KM);
      expect(MAX_DISCOVERY_RADIUS_KM).toBe(25);
    });

    it('accepts a radius within the Relay maximum', async () => {
      const result = await scriptedPlanner({
        items: validPlanItems(),
        geography: { radiusKm: 10, expansionAllowed: true },
      }).plan(testIntent());
      expect(result.status).toBe('ok');
      expect(result.plan?.geography).toEqual({ radiusKm: 10, expansionAllowed: true });
    });
  });

  describe('10-12. Fabrication is structurally impossible', () => {
    it('rejects supplier identity fabrication', async () => {
      const items = validPlanItems() as Array<Record<string, unknown>>;
      items[0].supplierName = 'Sahyadri Agro';
      items[0].address = 'Pune';
      items[0].phone = '+91 98000 00000';
      const itemLevel = await scriptedPlanner({ items }).plan(testIntent());
      expect(itemLevel.status).toBe('invalid');
      expect(itemLevel.issues[0].code).toBe('EXTRA_FIELD');

      const topLevel = await scriptedPlanner({
        items: validPlanItems(),
        supplierId: SEED_IDS.suppliers.sahyadri,
      }).plan(testIntent());
      expect(topLevel.status).toBe('invalid');
    });

    it('rejects price and payment fabrication', async () => {
      const items = validPlanItems() as Array<Record<string, unknown>>;
      items[1].price = 99.5;
      items[1].unitPrice = 49.75;
      const result = await scriptedPlanner({ items }).plan(testIntent());
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('EXTRA_FIELD');
    });

    it('rejects availability, rating, and SLA fabrication', async () => {
      const items = validPlanItems() as Array<Record<string, unknown>>;
      items[2].availability = 'in_stock';
      items[2].rating = 4.8;
      items[2].slaHours = 6;
      items[2].authorized = true;
      const result = await scriptedPlanner({ items }).plan(testIntent());
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('EXTRA_FIELD');
    });
  });

  describe('13-14. Malformed tool calls', () => {
    it('rejects prose with no tool call', async () => {
      const mock = new MockModelProvider([{ content: 'Try the supermarket.' }]);
      const result = await new DiscoveryPlanner({ provider: mock }).plan(testIntent());
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('NO_TOOL_CALL');
    });

    it('rejects wrong-shaped arguments', async () => {
      const result = await scriptedPlanner({ foo: 1 }).plan(testIntent());
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toMatch(/SCHEMA_VIOLATION|EXTRA_FIELD/);
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
              { id: 'c1', name: DISCOVERY_TOOL_NAME, arguments: { items: [] } },
              { id: 'c2', name: DISCOVERY_TOOL_NAME, arguments: { items: [] } },
            ],
          }) as never,
      };
      const result = await new DiscoveryPlanner({ provider }).plan(testIntent());
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('MULTIPLE_TOOL_CALLS');
    });
  });

  describe('15-16. Search-term bounds', () => {
    it('rejects empty and blank search terms', async () => {
      const items = validPlanItems();
      items[0].searchTerms = [];
      const empty = await scriptedPlanner({ items }).plan(testIntent());
      expect(empty.status).toBe('invalid');

      const items2 = validPlanItems();
      items2[0].searchTerms = ['   '];
      const blank = await scriptedPlanner({ items: items2 }).plan(testIntent());
      expect(blank.status).toBe('invalid');
    });

    it('rejects excessive search terms', async () => {
      const items = validPlanItems();
      items[0].searchTerms = Array.from({ length: 9 }, (_, i) => `term${i}`);
      const result = await scriptedPlanner({ items }).plan(testIntent());
      expect(result.status).toBe('invalid');
    });
  });

  describe('17. Mock compatibility and input guards', () => {
    it('plans each flagship product through the mock', async () => {
      for (const [productId, canonicalName, unit] of [
        [SEED_IDS.products.toothbrushes, 'toothbrush', ProductUnit.UNIT],
        [SEED_IDS.products.sugar, 'sugar', ProductUnit.KG],
        [SEED_IDS.products.groundnut, 'groundnut', ProductUnit.KG],
      ] as const) {
        const intent: ValidatedIntent = {
          originalRequest: 'probe',
          items: [resolvedItem(productId, canonicalName, 2, unit)],
        };
        const result = await mockPlanner().plan(intent);
        expect(result.status).toBe('ok');
        expect(result.plan?.fulfillment).toBeUndefined();
      }
    });

    it('refuses unresolved intents and surfaces provider errors', async () => {
      const unresolved: ValidatedIntent = {
        originalRequest: 'probe',
        items: [
          {
            productName: 'icecream',
            quantity: 3,
            unit: ProductUnit.PACK,
            constraints: [],
            resolution: { status: 'unresolved', reason: 'UNMAPPABLE_PRODUCT' },
          },
        ],
      };
      const refused = await mockPlanner().plan(unresolved);
      expect(refused.status).toBe('invalid');
      expect(refused.issues[0].code).toBe('UNRESOLVED_INTENT');

      const errored = await new DiscoveryPlanner({
        provider: new MetaModelProvider({ apiKey: '' }),
      }).plan(testIntent());
      expect(errored.status).toBe('error');
      expect(errored.issues[0].code).toBe('META_API_KEY_MISSING');
    });

    it('rejects invented, missing, and mismatched products', async () => {
      const invented = validPlanItems();
      invented[0].productId = '00000000-0000-0000-0000-000000000000';
      const unknown = await scriptedPlanner({ items: invented }).plan(testIntent());
      expect(unknown.status).toBe('invalid');
      expect(unknown.issues[0].code).toBe('UNKNOWN_PRODUCT');

      const dropped = validPlanItems().slice(0, 2);
      const missing = await scriptedPlanner({ items: dropped }).plan(testIntent());
      expect(missing.status).toBe('invalid');
      expect(missing.issues[0].code).toBe('MISSING_ITEM');

      const renamed = validPlanItems();
      renamed[1].productName = 'honey';
      const mismatched = await scriptedPlanner({ items: renamed }).plan(testIntent());
      expect(mismatched.status).toBe('invalid');
      expect(mismatched.issues[0].code).toBe('PRODUCT_MISMATCH');
    });

    it('leaves the default mock procurement loop untouched', async () => {
      const mock = new MockModelProvider();
      const response = await mock.generateWithTools({
        messages: [{ role: 'user', content: 'I need 5L cooking oil' }],
        tools: [],
      });
      expect(response.toolCalls?.[0].name).toBe('createRequest');
    });
  });

  describe('18. Meta structured output (mocked HTTP)', () => {
    it('plans through MetaModelProvider tool calls', async () => {
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
                        id: 'call_meta_plan',
                        function: {
                          name: DISCOVERY_TOOL_NAME,
                          arguments: JSON.stringify({
                            items: validPlanItems(),
                            geography: { radiusKm: 5, expansionAllowed: false },
                            fulfillment: { maxHours: 12 },
                            strategy: { prioritizeLocal: true },
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
      const result = await new DiscoveryPlanner({ provider }).plan(testIntent());
      expect(result.status).toBe('ok');
      expect(result.plan?.items.length).toBe(3);
      expect(result.plan?.strategy).toEqual({ prioritizeLocal: true });
    });
  });

  describe('19. Deterministic provider-request construction', () => {
    it('builds one Geoapify-shaped query per item from Relay inputs', async () => {
      const planned = await mockPlanner().plan(testIntent());
      expect(planned.status).toBe('ok');
      const queries = buildDiscoveryQueries(planned.plan!, {
        coordinates: { latitude: 18.5204, longitude: 73.8567 },
      });
      expect(queries.length).toBe(3);
      for (const q of queries) {
        expect(q.coordinates).toEqual({ latitude: 18.5204, longitude: 73.8567 });
        expect(q.radiusMeters).toBe(5000);
        expect(q.limit).toBe(20);
        expect(q.searchTerm && q.searchTerm.length).toBeGreaterThan(0);
        expect(q.categories!.length).toBeGreaterThan(0);
      }
      expect(queries[0].searchTerm).toBe(planned.plan!.items[0].searchTerms[0]);

      const candidates = await new MockSupplierDiscoveryProvider().discoverSuppliers(
        queries[0]
      );
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].source).toBe('mock');
    });

    it('rejects invalid Relay runtime inputs', async () => {
      const planned = await mockPlanner().plan(testIntent());
      const plan = planned.plan!;
      expect(() =>
        buildDiscoveryQueries(plan, {
          coordinates: { latitude: 999, longitude: 0 },
        })
      ).toThrowError(DiscoveryPlanError);
      expect(() =>
        buildDiscoveryQueries(plan, {
          coordinates: { latitude: 18.5, longitude: 73.8 },
          limit: 0,
        })
      ).toThrowError(DiscoveryPlanError);
    });
  });

  describe('live Meta discovery plan (config-gated)', () => {
    it.skipIf(!LIVE_ENABLED)(
      'returns a valid 3-item discovery plan with constraints preserved',
      async () => {
        const planner = new DiscoveryPlanner({
          provider: new MetaModelProvider({ timeoutMs: 30000 }),
        });
        const result = await planner.plan(testIntent());
        expect(result.status).toBe('ok');
        expect(result.issues).toEqual([]);
        expect(result.plan?.items.length).toBe(3);
        expect(result.plan?.items.map((i) => i.quantity).sort()).toEqual([2, 2, 2]);
        expect(
          result.plan?.items
            .map((i) => i.productId)
            .sort()
        ).toEqual(
          [
            SEED_IDS.products.toothbrushes,
            SEED_IDS.products.sugar,
            SEED_IDS.products.groundnut,
          ].sort()
        );
        for (const item of result.plan!.items) {
          expect(item.searchTerms.length).toBeGreaterThanOrEqual(1);
          expect(item.categories.length).toBeGreaterThanOrEqual(1);
          expect(item.supplierTypes.length).toBeGreaterThanOrEqual(1);
        }
        expect(result.plan?.fulfillment?.maxHours).toBeLessThanOrEqual(12);
        expect(result.plan?.fulfillment?.maxHours).toBeGreaterThan(0);
        expect(result.plan?.geography.radiusKm).toBeLessThanOrEqual(25);
        expect(result.plan?.geography.radiusKm).toBeGreaterThan(0);
        const serialized = JSON.stringify(result.plan);
        expect(serialized).not.toMatch(/supplierName|supplierId|address|phone|rating|price|amount|authoriz|availab/i);
      },
      45000
    );
  });
});
