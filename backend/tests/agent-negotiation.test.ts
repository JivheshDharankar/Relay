import { describe, it, expect } from 'vitest';
import {
  NegotiationStrategist,
  StrategyContext,
  strategyToProposalInput,
  NEGOTIATION_TOOL_NAME,
  MockModelProvider,
  MetaModelProvider,
  ModelProvider,
} from '../src/agent';
import { RFQService } from '../src/discovery/supplier/rfq/RFQService';
import { SupplierResponseService } from '../src/discovery/supplier/quote/provider/SupplierResponseService';
import { QuoteNormalizationService } from '../src/discovery/supplier/quote/QuoteNormalizationService';
import { NegotiationService } from '../src/discovery/supplier/negotiation/NegotiationService';
import { SupplierCandidate } from '../src/discovery/supplier/types';
import { SEED_IDS } from '../prisma/seed';

const POLICY = {
  minPriceImprovementPercent: 1,
  minPriceImprovementAbsolute: 5,
  minDeliveryHoursImprovement: 1,
  maxDiscountPercent: 35,
};

function testContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    negotiationId: 'nego_test_01',
    quoteId: 'quote_test_01',
    rfqId: 'rfq_test_01',
    candidateId: 'cand_test_01',
    supplierName: 'Test Wholesaler',
    productId: SEED_IDS.products.sugar,
    productName: 'sugar',
    quantity: 2,
    unit: 'KG',
    unitPrice: 61,
    deliveryFee: 0,
    deliveryEtaHours: 6,
    slaMaxHours: 12,
    slaDeadline: new Date(Date.now() + 12 * 3600 * 1000),
    currentRound: 0,
    maxRounds: 3,
    policy: { ...POLICY },
    ...overrides,
  };
}

function mockStrategist(): NegotiationStrategist {
  return new NegotiationStrategist({ provider: new MockModelProvider() });
}

function scriptedStrategist(args: unknown): NegotiationStrategist {
  const mock = new MockModelProvider([
    {
      toolCall: {
        id: 'call_strategy_scripted',
        name: NEGOTIATION_TOOL_NAME,
        arguments: args as Record<string, unknown>,
      },
    },
  ]);
  return new NegotiationStrategist({ provider: mock });
}

function baseArgs(ctx: StrategyContext, action: string, priority: string) {
  return {
    action,
    priority,
    objective: 'Improve commercial terms.',
    quoteId: ctx.quoteId,
    rfqId: ctx.rfqId,
    supplierId: ctx.candidateId,
    productId: ctx.productId,
    productName: ctx.productName,
    quantity: ctx.quantity,
    unit: ctx.unit,
    roundNumber: ctx.currentRound,
    rationale: 'Deterministic test rationale.',
    expectedBenefit: 'Lower cost.',
    stopConditions: ['Protect the 12-hour delivery commitment.'],
  };
}

const LIVE_ENABLED = process.env.META_LIVE_TEST === '1';

describe('Phase 14.5 — AI-assisted negotiation reasoning', () => {
  describe('1-5. Valid strategies (mock)', () => {
    it('proposes price reduction with a bounded target', async () => {
      const result = await mockStrategist().propose(testContext());
      expect(result.status).toBe('ok');
      expect(result.strategy?.action).toBe('REQUEST_PRICE_REDUCTION');
      expect(result.strategy?.requestedChange?.targetUnitPrice).toBe(57.95);
    });

    it('recognizes MOQ as the blocker without changing required quantity', async () => {
      const result = await mockStrategist().propose(
        testContext({ moqQuantity: 10 })
      );
      expect(result.status).toBe('ok');
      expect(result.strategy?.action).toBe('REQUEST_LOWER_MOQ');
      expect(result.strategy?.requestedChange?.targetQuantity).toBe(2);
      expect(result.strategy?.quantity).toBe(2);
    });

    it('proposes delivery improvement near the SLA without violating it', async () => {
      const result = await mockStrategist().propose(
        testContext({ deliveryEtaHours: 11 })
      );
      expect(result.status).toBe('ok');
      expect(result.strategy?.action).toBe('REQUEST_DELIVERY_IMPROVEMENT');
      expect(result.strategy?.requestedChange?.targetDeliveryEtaHours).toBe(10);
    });

    it('proposes delivery-fee reduction', async () => {
      const result = await mockStrategist().propose(
        testContext({ deliveryFee: 20 })
      );
      expect(result.status).toBe('ok');
      expect(result.strategy?.action).toBe('REQUEST_DELIVERY_FEE_REDUCTION');
      expect(result.strategy?.requestedChange?.targetDeliveryFee).toBe(0);
    });

    it('proposes bundle discount on verified community quantity', async () => {
      const result = await mockStrategist().propose(
        testContext({ communityQuantity: 10 })
      );
      expect(result.status).toBe('ok');
      expect(result.strategy?.action).toBe('REQUEST_BUNDLE_DISCOUNT');
      expect(result.strategy?.communityQuantity).toBe(10);
    });
  });

  describe('6-8. Clarification and terminal actions', () => {
    it('accepts clarification with a topic', async () => {
      const ctx = testContext();
      const result = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_CLARIFICATION', 'CLARIFICATION'),
        clarificationTopic: 'Confirm whether the delivery fee covers Sunday dispatch.',
      }).propose(ctx);
      expect(result.status).toBe('ok');
    });

    it('accepts terminal actions without targets', async () => {
      const ctx = testContext();
      for (const action of ['ACCEPT_CURRENT_OFFER', 'STOP_NEGOTIATION']) {
        const result = await scriptedStrategist({
          ...baseArgs(ctx, action, 'NONE'),
        }).propose(ctx);
        expect(result.status).toBe('ok');
      }
    });

    it('stops at the round limit via mock', async () => {
      const result = await mockStrategist().propose(
        testContext({ currentRound: 3 })
      );
      expect(result.status).toBe('ok');
      expect(result.strategy?.action).toBe('STOP_NEGOTIATION');
    });
  });

  describe('9-11. Forbidden actions are unrepresentable', () => {
    it('rejects payment, selection, and override actions', async () => {
      const ctx = testContext();
      for (const action of [
        'PAY_SUPPLIER',
        'CREATE_PAYMENT',
        'SELECT_SUPPLIER',
        'CHANGE_MANDATE',
        'OVERRIDE_SLA',
        'SKIP_QUALIFICATION',
        'REFUND',
      ]) {
        const result = await scriptedStrategist({
          ...baseArgs(ctx, action, 'NONE'),
        }).propose(ctx);
        expect(result.status).toBe('invalid');
        expect(result.issues[0].code).toBe('SCHEMA_VIOLATION');
      }
    });
  });

  describe('12-15. Commercial tampering rejected', () => {
    it('rejects quantity and unit mutation', async () => {
      const ctx = testContext();
      const qty = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'PRICE'),
        quantity: 10,
        requestedChange: { targetUnitPrice: 55 },
      }).propose(ctx);
      expect(qty.status).toBe('invalid');
      expect(qty.issues[0].code).toBe('QUANTITY_TAMPERED');

      const unit = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'PRICE'),
        unit: 'GRAM',
        requestedChange: { targetUnitPrice: 55 },
      }).propose(ctx);
      expect(unit.status).toBe('invalid');
      expect(unit.issues[0].code).toBe('UNIT_TAMPERED');
    });

    it('rejects deadline expansion structurally', async () => {
      const ctx = testContext();
      const result = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'PRICE'),
        requestedChange: { targetUnitPrice: 55 },
        fulfillment: { maxHours: 18 },
      }).propose(ctx);
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('EXTRA_FIELD');
    });

    it('rejects SLA violations and ETA regression', async () => {
      const ctx = testContext();
      const violation = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_DELIVERY_IMPROVEMENT', 'DELIVERY'),
        requestedChange: { targetDeliveryEtaHours: 18 },
      }).propose(ctx);
      expect(violation.status).toBe('invalid');
      expect(violation.issues.map((i) => i.code)).toContain('SLA_VIOLATION');

      const regression = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_DELIVERY_IMPROVEMENT', 'DELIVERY'),
        requestedChange: { targetDeliveryEtaHours: 8 },
      }).propose(ctx);
      expect(regression.status).toBe('invalid');
      expect(regression.issues[0].code).toBe('TARGET_EXCEEDS_CURRENT');
    });
  });

  describe('16. Round limits enforced', () => {
    it('rejects round 4 proposals but allows terminal actions', async () => {
      const ctx = testContext({ currentRound: 3 });
      const price = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'PRICE'),
        requestedChange: { targetUnitPrice: 55 },
      }).propose(ctx);
      expect(price.status).toBe('invalid');
      expect(price.issues[0].code).toBe('ROUND_LIMIT_EXCEEDED');

      const stop = await scriptedStrategist({
        ...baseArgs(ctx, 'STOP_NEGOTIATION', 'NONE'),
      }).propose(ctx);
      expect(stop.status).toBe('ok');
    });
  });

  describe('17. Supplier fabrication rejected', () => {
    it('rejects fabricated counter-offers and responses', async () => {
      const ctx = testContext();
      for (const extra of [
        { counterOffer: { unitPrice: 55 } },
        { supplierResponse: 'accepted' },
        { supplierAccepted: true },
      ]) {
        const result = await scriptedStrategist({
          ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'PRICE'),
          requestedChange: { targetUnitPrice: 55 },
          ...extra,
        }).propose(ctx);
        expect(result.status).toBe('invalid');
        expect(result.issues[0].code).toBe('EXTRA_FIELD');
      }
    });
  });

  describe('18. Price manipulation rejected', () => {
    it('rejects targets above current, unrealistic, and trivial targets', async () => {
      const ctx = testContext();
      const above = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'PRICE'),
        requestedChange: { targetUnitPrice: 70 },
      }).propose(ctx);
      expect(above.status).toBe('invalid');
      expect(above.issues[0].code).toBe('TARGET_EXCEEDS_CURRENT');

      const deep = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'PRICE'),
        requestedChange: { targetUnitPrice: 30 },
      }).propose(ctx);
      expect(deep.status).toBe('invalid');
      expect(deep.issues[0].code).toBe('UNREALISTIC_DISCOUNT');

      const trivial = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'PRICE'),
        requestedChange: { targetUnitPrice: 60.9 },
      }).propose(ctx);
      expect(trivial.status).toBe('invalid');
      expect(trivial.issues[0].code).toBe('NO_MEANINGFUL_IMPROVEMENT');
    });
  });

  describe('19-22. Identity and context integrity', () => {
    it('rejects missing quote context', async () => {
      const result = await mockStrategist().propose(
        testContext({ quoteId: '' })
      );
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('INVALID_CONTEXT');
    });

    it('rejects wrong supplier, product, and quote echoes', async () => {
      const ctx = testContext();
      const base = {
        ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'PRICE'),
        requestedChange: { targetUnitPrice: 55 },
      };
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ supplierId: 'other' }, 'SUPPLIER_MISMATCH'],
        [{ productId: 'other' }, 'PRODUCT_MISMATCH'],
        [{ productName: 'honey' }, 'PRODUCT_MISMATCH'],
        [{ quoteId: 'other' }, 'QUOTE_MISMATCH'],
        [{ rfqId: 'other' }, 'RFQ_MISMATCH'],
        [{ roundNumber: 5 }, 'ROUND_MISMATCH'],
      ];
      for (const [override, code] of cases) {
        const result = await scriptedStrategist({ ...base, ...override }).propose(ctx);
        expect(result.status).toBe('invalid');
        expect(result.issues.map((i) => i.code)).toContain(code);
      }
    });

    it('rejects invalid community quantities', async () => {
      const ctx = testContext({ communityQuantity: 10 });
      const mismatch = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_BUNDLE_DISCOUNT', 'BUNDLE'),
        communityQuantity: 99,
      }).propose(ctx);
      expect(mismatch.status).toBe('invalid');
      expect(mismatch.issues[0].code).toBe('COMMUNITY_QUANTITY_MISMATCH');

      const noBasis = await scriptedStrategist({
        ...baseArgs(testContext(), 'REQUEST_BUNDLE_DISCOUNT', 'BUNDLE'),
        communityQuantity: 10,
      }).propose(testContext());
      expect(noBasis.status).toBe('invalid');
      expect(noBasis.issues[0].code).toBe('NO_COMMUNITY_BASIS');
    });
  });

  describe('23-25. Malformed output', () => {
    it('rejects wrong-shaped arguments', async () => {
      const result = await scriptedStrategist({ foo: 1 }).propose(testContext());
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
              { id: 'c1', name: NEGOTIATION_TOOL_NAME, arguments: {} },
              { id: 'c2', name: NEGOTIATION_TOOL_NAME, arguments: {} },
            ],
          }) as never,
      };
      const result = await new NegotiationStrategist({ provider }).propose(
        testContext()
      );
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('MULTIPLE_TOOL_CALLS');
    });

    it('rejects prose with no tool call', async () => {
      const mock = new MockModelProvider([{ content: 'Try lowering the price.' }]);
      const result = await new NegotiationStrategist({ provider: mock }).propose(
        testContext()
      );
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('NO_TOOL_CALL');
    });
  });

  describe('coherence and safety screening', () => {
    it('rejects priority/action mismatch and target misuse', async () => {
      const ctx = testContext();
      const mismatch = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'MOQ'),
        requestedChange: { targetUnitPrice: 55 },
      }).propose(ctx);
      expect(mismatch.status).toBe('invalid');
      expect(mismatch.issues[0].code).toBe('PRIORITY_MISMATCH');

      const mixed = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'PRICE'),
        requestedChange: { targetUnitPrice: 55, targetDeliveryFee: 0 },
      }).propose(ctx);
      expect(mixed.status).toBe('invalid');
      expect(mixed.issues[0].code).toBe('MIXED_TARGETS');

      const missing = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'PRICE'),
      }).propose(ctx);
      expect(missing.status).toBe('invalid');
      expect(missing.issues[0].code).toBe('TARGET_REQUIRED');

      const terminalTarget = await scriptedStrategist({
        ...baseArgs(ctx, 'ACCEPT_CURRENT_OFFER', 'NONE'),
        requestedChange: { targetUnitPrice: 55 },
      }).propose(ctx);
      expect(terminalTarget.status).toBe('invalid');
      expect(terminalTarget.issues[0].code).toBe('TARGET_NOT_ALLOWED');
    });

    it('rejects MOQ targets that rewrite required quantity', async () => {
      const ctx = testContext({ moqQuantity: 10 });
      const result = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_LOWER_MOQ', 'MOQ'),
        requestedChange: { targetQuantity: 10 },
      }).propose(ctx);
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('QUANTITY_TAMPERED');
    });

    it('screens model text for privacy and prompt leakage', async () => {
      const ctx = testContext();
      const pii = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'PRICE'),
        requestedChange: { targetUnitPrice: 55 },
        rationale: 'Resident in Flat 101 needs this urgently.',
      }).propose(ctx);
      expect(pii.status).toBe('invalid');
      expect(pii.issues[0].code).toBe('PRIVACY_VIOLATION');

      const leak = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'PRICE'),
        requestedChange: { targetUnitPrice: 55 },
        rationale: 'As an AI language model, I suggest a discount.',
      }).propose(ctx);
      expect(leak.status).toBe('invalid');
      expect(leak.issues[0].code).toBe('PROMPT_LEAKAGE');
    });

    it('rejects competitor identity leaks', async () => {
      const ctx = testContext({ competitorNames: ['Rival Corp'] });
      const result = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'PRICE'),
        requestedChange: { targetUnitPrice: 55 },
        rationale: 'Rival Corp offered a lower price, so match it.',
      }).propose(ctx);
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('CONFIDENTIALITY_VIOLATION');
    });

    it('rejects delivery improvement against unknown ETA', async () => {
      const ctx = testContext({ deliveryEtaHours: undefined });
      const result = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_DELIVERY_IMPROVEMENT', 'DELIVERY'),
        requestedChange: { targetDeliveryEtaHours: 5 },
      }).propose(ctx);
      expect(result.status).toBe('invalid');
      expect(result.issues[0].code).toBe('DELIVERY_UNKNOWN');
    });

    it('surfaces provider errors as error status', async () => {
      const strategist = new NegotiationStrategist({
        provider: new MetaModelProvider({ apiKey: '' }),
      });
      const result = await strategist.propose(testContext());
      expect(result.status).toBe('error');
      expect(result.issues[0].code).toBe('META_API_KEY_MISSING');
    });
  });

  describe('26. Engine bridge', () => {
    it('converts numeric strategies and rejects the rest explicitly', async () => {
      const ctx = testContext();
      const price = await scriptedStrategist({
        ...baseArgs(ctx, 'REQUEST_PRICE_REDUCTION', 'PRICE'),
        requestedChange: { targetUnitPrice: 55 },
      }).propose(ctx);
      const converted = strategyToProposalInput(price.strategy!, ctx);
      expect(converted.convertible).toBe(true);
      if (converted.convertible) {
        expect(converted.input.strategy).toBe('LOWER_PRICE');
        expect(converted.input.requestedChanges.targetUnitPrice).toBe(55);
        expect(converted.input.negotiationId).toBe(ctx.negotiationId);
        expect(converted.input).not.toHaveProperty('supplierFacingMessage');
      }

      const moqCtx = testContext({ moqQuantity: 10 });
      const moq = await scriptedStrategist({
        ...baseArgs(moqCtx, 'REQUEST_LOWER_MOQ', 'MOQ'),
        requestedChange: { targetQuantity: 2 },
      }).propose(moqCtx);
      const moqConversion = strategyToProposalInput(moq.strategy!, moqCtx);
      expect(moqConversion).toMatchObject({ convertible: false, terminal: false });

      const stop = await scriptedStrategist({
        ...baseArgs(ctx, 'STOP_NEGOTIATION', 'NONE'),
      }).propose(ctx);
      const stopConversion = strategyToProposalInput(stop.strategy!, ctx);
      expect(stopConversion).toMatchObject({ convertible: false, terminal: true });
    });

    it('executes a converted strategy through the real engine', async () => {
      const candidate: SupplierCandidate = {
        id: 'cand_test_01',
        name: 'Test Wholesaler',
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
          lineItems: [{ productName: 'sugar', quantity: 2, unit: 'KG' }],
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
        lineItems: [
          { productName: 'sugar', quotedQuantity: 2, unit: 'KG', unitPrice: 61 },
        ],
        deliveryEtaHours: 6,
      });
      const normalizationService = new QuoteNormalizationService();
      const normalized = await normalizationService.normalizeResponse(response, now);
      expect(normalized.quote.status).toBe('VALID');

      const negotiationService = new NegotiationService(normalizationService, rfqService);
      const negotiation = await negotiationService.startNegotiation({
        rfqId: rfq.id,
        quoteId: normalized.quote.id,
      });
      const ctx = testContext({
        negotiationId: negotiation.id,
        quoteId: normalized.quote.id,
        rfqId: rfq.id,
        candidateId: candidate.id,
        quantity: 2,
        unit: 'KG',
        unitPrice: 61,
        deliveryFee: 0,
        deliveryEtaHours: 6,
        slaDeadline: rfq.deliveryDeadline,
      });
      const proposed = await mockStrategist().propose(ctx);
      expect(proposed.status).toBe('ok');
      const conversion = strategyToProposalInput(proposed.strategy!, ctx);
      expect(conversion.convertible).toBe(true);
      if (!conversion.convertible) throw new Error('expected convertible strategy');
      const proposal = await negotiationService.createProposal(conversion.input);
      expect(proposal.status).toBe('VALIDATED');
      expect(proposal.strategy).toBe('LOWER_PRICE');
      expect(proposal.roundNumber).toBe(1);
      expect(proposal.requestedChanges.targetUnitPrice).toBe(57.95);
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
  });

  describe('live Meta negotiation strategy (config-gated)', () => {
    it.skipIf(!LIVE_ENABLED)(
      'returns a valid strategy for a verified quote',
      async () => {
        const strategist = new NegotiationStrategist({
          provider: new MetaModelProvider({ timeoutMs: 30000 }),
        });
        const ctx = testContext({
          unitPrice: 61,
          moqQuantity: 2,
          deliveryEtaHours: 6,
          deliveryFee: 20,
          communityQuantity: 10,
          currentRound: 0,
        });
        const result = await strategist.propose(ctx);
        expect(result.status).toBe('ok');
        expect(result.issues).toEqual([]);
        expect([
          'REQUEST_PRICE_REDUCTION',
          'REQUEST_LOWER_MOQ',
          'REQUEST_DELIVERY_IMPROVEMENT',
          'REQUEST_DELIVERY_FEE_REDUCTION',
          'REQUEST_BUNDLE_DISCOUNT',
          'REQUEST_CLARIFICATION',
          'ACCEPT_CURRENT_OFFER',
          'STOP_NEGOTIATION',
        ]).toContain(result.strategy?.action);
        expect(result.strategy?.quantity).toBe(2);
        expect(result.strategy?.unit).toBe('KG');
        expect(result.strategy?.roundNumber).toBe(0);
        expect(result.strategy?.quoteId).toBe(ctx.quoteId);
        expect(result.strategy?.supplierId).toBe(ctx.candidateId);
        expect(result.strategy?.rationale.length).toBeGreaterThan(0);
        expect(result.strategy?.stopConditions.length).toBeGreaterThan(0);
        const serialized = JSON.stringify(result.strategy);
        expect(serialized).not.toMatch(
          /counterOffer|supplierResponse|supplierAccepted|createPayment|paySupplier|selectSupplier|refund/i
        );
      },
      45000
    );
  });
});
