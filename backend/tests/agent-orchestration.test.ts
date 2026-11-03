import { describe, it, expect } from 'vitest';
import {
  OrchestrationPlanner,
  RoutingContext,
  resolveRoute,
  workflowToRoutingContext,
  ORCHESTRATION_TOOL_NAME,
  MockModelProvider,
  MetaModelProvider,
  ModelProvider,
} from '../src/agent';
import { RelayOrchestrator } from '../src/orchestration/RelayOrchestrator';
import { WorkflowStage } from '../src/orchestration/types';

function testContext(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    workflowId: 'wf_test_01',
    currentStage: 'UNDERSTAND',
    workflowStatus: 'UNDERSTANDING',
    intent: {
      status: 'resolved',
      quantities: [2, 2, 2],
      units: ['UNIT', 'KG', 'KG'],
      deadlineHours: 12,
    },
    suppliersDiscovered: 0,
    suppliersQualified: 0,
    quotesReceived: 0,
    quotesInterpreted: 0,
    rawResponsesPending: 0,
    negotiationRound: 0,
    negotiationMaxRounds: 3,
    negotiationEligible: false,
    awaitingExternal: false,
    blockers: [],
    communityQuantity: 10,
    ...overrides,
  };
}

function mockPlanner(): OrchestrationPlanner {
  return new OrchestrationPlanner({ provider: new MockModelProvider() });
}

function scriptedPlanner(args: unknown): OrchestrationPlanner {
  const mock = new MockModelProvider([
    {
      toolCall: {
        id: 'call_route_scripted',
        name: ORCHESTRATION_TOOL_NAME,
        arguments: args as Record<string, unknown>,
      },
    },
  ]);
  return new OrchestrationPlanner({ provider: mock });
}

function baseArgs(
  ctx: RoutingContext,
  action: string,
  targetStage: string,
  priority: string
) {
  const args: Record<string, unknown> = {
    action,
    currentStage: ctx.currentStage,
    targetStage,
    priority,
    objective: 'Advance the workflow.',
    rationale: 'Deterministic test rationale.',
    verifiedContext: {
      itemCount: ctx.intent.quantities.length,
      quantities: [...ctx.intent.quantities],
      units: [...ctx.intent.units],
    },
    stopConditions: ['Protect the 12-hour delivery commitment.'],
  };
  if (ctx.intent.deadlineHours !== undefined) {
    (args.verifiedContext as Record<string, unknown>).deadlineHours =
      ctx.intent.deadlineHours;
  }
  return args;
}

const LIVE_ENABLED = process.env.META_LIVE_TEST === '1';

describe('Phase 15 — AI orchestration & decision routing', () => {
  describe('valid decisions (mock)', () => {
    it('routes unresolved intent to understanding', async () => {
      const ctx = testContext({
        intent: { status: 'ambiguous', quantities: [], units: [] },
      });
      const result = await mockPlanner().planNextAction(ctx);
      expect(result.status).toBe('ok');
      expect(result.decision?.action).toBe('UNDERSTAND_REQUEST');
      expect(result.decision?.targetStage).toBe('UNDERSTAND');
    });

    it('routes verified intent to discovery planning', async () => {
      const result = await mockPlanner().planNextAction(testContext());
      expect(result.status).toBe('ok');
      expect(result.decision?.action).toBe('PLAN_DISCOVERY');
      expect(result.decision?.targetStage).toBe('DISCOVER');
      expect(result.decision?.quantities).toEqual([2, 2, 2]);
    });

    it('routes discovered suppliers to qualification', async () => {
      const ctx = testContext({ currentStage: 'DISCOVER', suppliersDiscovered: 2 });
      const result = await mockPlanner().planNextAction(ctx);
      expect(result.status).toBe('ok');
      expect(result.decision?.action).toBe('QUALIFY_SUPPLIERS');
      expect(result.decision?.targetStage).toBe('QUALIFY');
    });

    it('routes qualified suppliers to quote requests', async () => {
      const ctx = testContext({
        currentStage: 'QUALIFY',
        suppliersDiscovered: 2,
        suppliersQualified: 1,
      });
      const result = await mockPlanner().planNextAction(ctx);
      expect(result.status).toBe('ok');
      expect(result.decision?.action).toBe('REQUEST_QUOTES');
      expect(result.decision?.targetStage).toBe('QUOTE');
    });

    it('routes pending raw responses to interpretation', async () => {
      const ctx = testContext({
        currentStage: 'QUOTE',
        suppliersDiscovered: 2,
        suppliersQualified: 1,
        rawResponsesPending: 1,
      });
      const result = await mockPlanner().planNextAction(ctx);
      expect(result.status).toBe('ok');
      expect(result.decision?.action).toBe('INTERPRET_QUOTES');
      expect(result.decision?.targetStage).toBe('QUOTE');
    });

    it('routes eligible quotes to negotiation planning', async () => {
      const ctx = testContext({
        currentStage: 'QUOTE',
        suppliersDiscovered: 2,
        suppliersQualified: 1,
        quotesReceived: 1,
        negotiationEligible: true,
      });
      const result = await mockPlanner().planNextAction(ctx);
      expect(result.status).toBe('ok');
      expect(result.decision?.action).toBe('PLAN_NEGOTIATION');
      expect(result.decision?.targetStage).toBe('NEGOTIATE');
    });

    it('routes verified quotes to selection', async () => {
      const ctx = testContext({
        currentStage: 'QUOTE',
        suppliersDiscovered: 2,
        suppliersQualified: 1,
        quotesReceived: 1,
      });
      const result = await mockPlanner().planNextAction(ctx);
      expect(result.status).toBe('ok');
      expect(result.decision?.action).toBe('SELECT_SUPPLIER');
      expect(result.decision?.targetStage).toBe('SELECT');
    });

    it('supports clarification, waiting, and stop', async () => {
      const clarifyCtx = testContext({
        currentStage: 'QUOTE',
        intent: { status: 'ambiguous', quantities: [2], units: ['KG'], deadlineHours: 12 },
      });
      const clarify = await mockPlanner().planNextAction(clarifyCtx);
      expect(clarify.status).toBe('ok');
      expect(clarify.decision?.action).toBe('REQUEST_CLARIFICATION');
      expect(clarify.decision?.targetStage).toBe('QUOTE');

      const waitCtx = testContext({ currentStage: 'QUOTE', awaitingExternal: true });
      const wait = await mockPlanner().planNextAction(waitCtx);
      expect(wait.status).toBe('ok');
      expect(wait.decision?.action).toBe('WAIT_FOR_EXTERNAL_RESPONSE');

      const stopCtx = testContext({ blockers: ['NO_ELIGIBLE_SUPPLIERS'] });
      const stop = await mockPlanner().planNextAction(stopCtx);
      expect(stop.status).toBe('ok');
      expect(stop.decision?.action).toBe('STOP_AUTONOMOUS_RUN');
    });
  });

  describe('invalid decisions', () => {
    it('rejects unknown actions and invented stages', async () => {
      const ctx = testContext();
      const unknownAction = await scriptedPlanner({
        ...baseArgs(ctx, 'EXECUTE_PAYMENT', 'PAY', 'STOP'),
      }).planNextAction(ctx);
      expect(unknownAction.status).toBe('invalid');
      expect(unknownAction.issues[0].code).toBe('SCHEMA_VIOLATION');

      const inventedStage = await scriptedPlanner({
        ...baseArgs(ctx, 'PLAN_DISCOVERY', 'NEGOTIATE_HARDER', 'DISCOVER'),
      }).planNextAction(ctx);
      expect(inventedStage.status).toBe('invalid');
      expect(inventedStage.issues[0].code).toBe('UNKNOWN_STAGE');
    });

    it('rejects stage mismatch and illegal transitions', async () => {
      const ctx = testContext();
      const mismatch = await scriptedPlanner({
        ...baseArgs(ctx, 'PLAN_DISCOVERY', 'DISCOVER', 'DISCOVER'),
        currentStage: 'DISCOVER',
      }).planNextAction(ctx);
      expect(mismatch.status).toBe('invalid');
      expect(mismatch.issues.map((i) => i.code)).toContain('STAGE_MISMATCH');

      const quoteCtx = testContext({ currentStage: 'QUOTE' });
      const illegal = await scriptedPlanner({
        ...baseArgs(quoteCtx, 'PLAN_DISCOVERY', 'DISCOVER', 'DISCOVER'),
      }).planNextAction(quoteCtx);
      expect(illegal.status).toBe('invalid');
      expect(illegal.issues.map((i) => i.code)).toContain('ILLEGAL_TRANSITION');
    });

    it('rejects target/action mismatch', async () => {
      const ctx = testContext();
      const result = await scriptedPlanner({
        ...baseArgs(ctx, 'PLAN_DISCOVERY', 'QUALIFY', 'DISCOVER'),
      }).planNextAction(ctx);
      expect(result.status).toBe('invalid');
      expect(result.issues.map((i) => i.code)).toContain('TARGET_MISMATCH');
    });

    it('rejects missing required context and unknown vocabulary', async () => {
      const ctx = testContext();
      const missing = await scriptedPlanner({
        ...baseArgs(ctx, 'PLAN_DISCOVERY', 'DISCOVER', 'DISCOVER'),
        requiredContext: ['received-quotes'],
      }).planNextAction(ctx);
      expect(missing.status).toBe('invalid');
      expect(missing.issues[0].code).toBe('MISSING_REQUIRED_CONTEXT');

      const unknownCtx = await scriptedPlanner({
        ...baseArgs(ctx, 'PLAN_DISCOVERY', 'DISCOVER', 'DISCOVER'),
        requiredContext: ['resident-bank-balance'],
      }).planNextAction(ctx);
      expect(unknownCtx.status).toBe('invalid');
      expect(unknownCtx.issues[0].code).toBe('UNKNOWN_CONTEXT');

      const unknownCap = await scriptedPlanner({
        ...baseArgs(ctx, 'PLAN_DISCOVERY', 'DISCOVER', 'DISCOVER'),
        requiredCapabilities: ['run_gpu_cluster'],
      }).planNextAction(ctx);
      expect(unknownCap.status).toBe('invalid');
      expect(unknownCap.issues[0].code).toBe('UNKNOWN_CAPABILITY');
    });

    it('rejects arbitrary tools, endpoints, and fields', async () => {
      const ctx = testContext();
      for (const extra of [
        { tool: 'bash' },
        { endpoint: 'https://evil.example.com/run' },
        { foo: 1 },
      ]) {
        const result = await scriptedPlanner({
          ...baseArgs(ctx, 'PLAN_DISCOVERY', 'DISCOVER', 'DISCOVER'),
          ...extra,
        }).planNextAction(ctx);
        expect(result.status).toBe('invalid');
        expect(result.issues[0].code).toBe('EXTRA_FIELD');
      }
    });

    it('rejects malformed, multiple, and missing tool calls', async () => {
      const malformed = await scriptedPlanner({ action: 'PLAN_DISCOVERY' }).planNextAction(
        testContext()
      );
      expect(malformed.status).toBe('invalid');
      expect(malformed.issues[0].code).toBe('SCHEMA_VIOLATION');

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
              { id: 'c1', name: ORCHESTRATION_TOOL_NAME, arguments: {} },
              { id: 'c2', name: ORCHESTRATION_TOOL_NAME, arguments: {} },
            ],
          }) as never,
      };
      const multiple = await new OrchestrationPlanner({ provider }).planNextAction(
        testContext()
      );
      expect(multiple.status).toBe('invalid');
      expect(multiple.issues[0].code).toBe('MULTIPLE_TOOL_CALLS');

      const mock = new MockModelProvider([{ content: 'Proceed to discovery.' }]);
      const none = await new OrchestrationPlanner({ provider: mock }).planNextAction(
        testContext()
      );
      expect(none.status).toBe('invalid');
      expect(none.issues[0].code).toBe('NO_TOOL_CALL');
    });
  });

  describe('authority attacks fail closed', () => {
    it('rejects every protected-domain injection', async () => {
      const ctx = testContext();
      const base = baseArgs(ctx, 'PLAN_DISCOVERY', 'DISCOVER', 'DISCOVER');
      for (const extra of [
        { paymentAmount: 500 },
        { paymentRecipient: 'sup_1' },
        { supplierPrice: 55 },
        { supplierIdentity: 'Acme' },
        { fulfillmentState: 'DELIVERED' },
        { allocationAmount: 100 },
        { reconciliationAmount: 100 },
        { authorization: 'approved' },
        { fakeSupplierResponse: 'accepted' },
      ]) {
        const result = await scriptedPlanner({ ...base, ...extra }).planNextAction(ctx);
        expect(result.status).toBe('invalid');
        expect(result.issues[0].code).toBe('EXTRA_FIELD');
      }
    });
  });

  describe('context tampering fails', () => {
    it('rejects quantity, unit, deadline, and count tampering', async () => {
      const ctx = testContext();
      const base = baseArgs(ctx, 'PLAN_DISCOVERY', 'DISCOVER', 'DISCOVER');
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ quantities: [2, 2, 3] }, 'QUANTITY_TAMPERED'],
        [{ units: ['UNIT', 'KG', 'GRAM'] }, 'UNIT_TAMPERED'],
        [{ deadlineHours: 18 }, 'DEADLINE_TAMPERED'],
        [{ itemCount: 2, quantities: [2, 2], units: ['UNIT', 'KG'] }, 'ITEM_COUNT_MISMATCH'],
      ];
      for (const [override, code] of cases) {
        const tampered = {
          ...base,
          verifiedContext: { ...(base.verifiedContext as object), ...override },
        };
        const result = await scriptedPlanner(tampered).planNextAction(ctx);
        expect(result.status).toBe('invalid');
        expect(result.issues.map((i) => i.code)).toContain(code);
      }

      const noDeadline = testContext({
        intent: { status: 'resolved', quantities: [2], units: ['KG'] },
      });
      const invented = await scriptedPlanner({
        ...baseArgs(noDeadline, 'PLAN_DISCOVERY', 'DISCOVER', 'DISCOVER'),
      }).planNextAction(noDeadline);
      // Control: omitting an absent deadline is valid.
      expect(invented.status).toBe('ok');

      const inventedBad = await scriptedPlanner({
        ...baseArgs(noDeadline, 'PLAN_DISCOVERY', 'DISCOVER', 'DISCOVER'),
        verifiedContext: { itemCount: 1, quantities: [2], units: ['KG'], deadlineHours: 12 },
      }).planNextAction(noDeadline);
      expect(inventedBad.status).toBe('invalid');
      expect(inventedBad.issues.map((i) => i.code)).toContain('DEADLINE_TAMPERED');
    });
  });

  describe('preconditions, terminality, and coherence', () => {
    it('enforces per-action preconditions', async () => {
      const ambiguous = testContext({
        intent: { status: 'ambiguous', quantities: [], units: [] },
      });
      const discovery = await scriptedPlanner({
        ...baseArgs(ambiguous, 'PLAN_DISCOVERY', 'DISCOVER', 'DISCOVER'),
      }).planNextAction(ambiguous);
      expect(discovery.status).toBe('invalid');
      expect(discovery.issues[0].code).toBe('PRECONDITION_FAILED');

      const resolved = testContext();
      const understand = await scriptedPlanner({
        ...baseArgs(resolved, 'UNDERSTAND_REQUEST', 'UNDERSTAND', 'UNDERSTAND'),
      }).planNextAction(resolved);
      expect(understand.status).toBe('invalid');
      expect(understand.issues[0].code).toBe('INTENT_ALREADY_RESOLVED');

      const quoteCtx = testContext({ currentStage: 'QUOTE' });
      const interpret = await scriptedPlanner({
        ...baseArgs(quoteCtx, 'INTERPRET_QUOTES', 'QUOTE', 'QUOTE'),
      }).planNextAction(quoteCtx);
      expect(interpret.status).toBe('invalid');
      expect(interpret.issues[0].code).toBe('PRECONDITION_FAILED');
    });

    it('restricts terminal and blocked workflows to stop', async () => {
      const done = testContext({ currentStage: 'COMPLETE', workflowStatus: 'COMPLETED' });
      const progress = await scriptedPlanner({
        ...baseArgs(done, 'PLAN_DISCOVERY', 'DISCOVER', 'DISCOVER'),
      }).planNextAction(done);
      expect(progress.status).toBe('invalid');
      expect(progress.issues.map((i) => i.code)).toContain('WORKFLOW_TERMINAL');

      const stop = await scriptedPlanner({
        ...baseArgs(done, 'STOP_AUTONOMOUS_RUN', 'COMPLETE', 'STOP'),
      }).planNextAction(done);
      expect(stop.status).toBe('ok');

      const blocked = testContext({ blockers: ['NO_ELIGIBLE_SUPPLIERS'] });
      const routed = await scriptedPlanner({
        ...baseArgs(blocked, 'PLAN_DISCOVERY', 'DISCOVER', 'DISCOVER'),
      }).planNextAction(blocked);
      expect(routed.status).toBe('invalid');
      expect(routed.issues.map((i) => i.code)).toContain('WORKFLOW_BLOCKED');
    });

    it('enforces priority coherence and text screening', async () => {
      const ctx = testContext();
      const incoherent = await scriptedPlanner({
        ...baseArgs(ctx, 'PLAN_DISCOVERY', 'DISCOVER', 'QUOTE'),
      }).planNextAction(ctx);
      expect(incoherent.status).toBe('invalid');
      expect(incoherent.issues[0].code).toBe('PRIORITY_MISMATCH');

      const pii = await scriptedPlanner({
        ...baseArgs(ctx, 'PLAN_DISCOVERY', 'DISCOVER', 'DISCOVER'),
        rationale: 'Resident in Flat 101 needs this urgently.',
      }).planNextAction(ctx);
      expect(pii.status).toBe('invalid');
      expect(pii.issues[0].code).toBe('PRIVACY_VIOLATION');
    });

    it('surfaces provider errors as error status', async () => {
      const planner = new OrchestrationPlanner({
        provider: new MetaModelProvider({ apiKey: '' }),
      });
      const result = await planner.planNextAction(testContext());
      expect(result.status).toBe('error');
      expect(result.issues[0].code).toBe('META_API_KEY_MISSING');
    });
  });

  describe('capability router', () => {
    it('maps every action through the Relay-owned route table', () => {
      expect(resolveRoute('UNDERSTAND_REQUEST')).toEqual({
        action: 'UNDERSTAND_REQUEST',
        route: { capability: 'intent-extractor', stage: 'UNDERSTAND' },
      });
      expect(resolveRoute('PLAN_DISCOVERY').route).toEqual({
        capability: 'discovery-planner',
        stage: 'DISCOVER',
      });
      expect(resolveRoute('INTERPRET_QUOTES').route).toEqual({
        capability: 'quote-interpreter',
        stage: 'QUOTE',
      });
      expect(resolveRoute('PLAN_NEGOTIATION').route).toEqual({
        capability: 'negotiation-strategist',
        stage: 'NEGOTIATE',
      });
      expect(resolveRoute('STOP_AUTONOMOUS_RUN').route.stage).toBeNull();
      expect(resolveRoute('WAIT_FOR_EXTERNAL_RESPONSE').route.stage).toBeNull();
    });
  });

  describe('engine integration', () => {
    it('derives routing context from a live authoritative workflow', async () => {
      const orchestrator = new RelayOrchestrator();
      const workflow = await orchestrator.submitRequest({
        requestText: 'I need 2 kg sugar.',
        residentReference: 'res_routing_probe_01',
      });
      expect(workflow.currentStage).toBe('UNDERSTAND');
      const context = workflowToRoutingContext(workflow, {
        intentStatus: 'missing',
        quantities: [],
        units: [],
        rawResponsesPending: 0,
        negotiationRound: 0,
        negotiationMaxRounds: 3,
        negotiationEligible: false,
        awaitingExternal: false,
        blockers: [],
      });
      expect(context.workflowId).toBe(workflow.id);
      expect(context.suppliersDiscovered).toBe(0);
      const result = await mockPlanner().planNextAction(context);
      expect(result.status).toBe('ok');
      expect(result.decision?.action).toBe('UNDERSTAND_REQUEST');
    });

    it('reads entity counts from workflow state for later stages', async () => {
      const orchestrator = new RelayOrchestrator();
      const workflow = await orchestrator.submitRequest({
        requestText: 'I need 2 kg sugar.',
        residentReference: 'res_routing_probe_02',
      });
      workflow.currentStage = 'DISCOVER' as WorkflowStage;
      workflow.entities.supplierCandidateIds = ['cand_1', 'cand_2'];
      const context = workflowToRoutingContext(workflow, {
        intentStatus: 'resolved',
        quantities: [2],
        units: ['KG'],
        deadlineHours: 12,
        rawResponsesPending: 0,
        negotiationRound: 0,
        negotiationMaxRounds: 3,
        negotiationEligible: false,
        awaitingExternal: false,
        blockers: [],
      });
      expect(context.suppliersDiscovered).toBe(2);
      const result = await mockPlanner().planNextAction(context);
      expect(result.status).toBe('ok');
      expect(result.decision?.action).toBe('QUALIFY_SUPPLIERS');
      expect(result.decision?.targetStage).toBe('QUALIFY');
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

  describe('live Meta orchestration routing (config-gated)', () => {
    it.skipIf(!LIVE_ENABLED)(
      'routes verified multi-item intent to discovery planning',
      async () => {
        const planner = new OrchestrationPlanner({
          provider: new MetaModelProvider({ timeoutMs: 30000 }),
        });
        const result = await planner.planNextAction(testContext());
        expect(result.status).toBe('ok');
        expect(result.issues).toEqual([]);
        expect(result.decision?.action).toBe('PLAN_DISCOVERY');
        expect(result.decision?.currentStage).toBe('UNDERSTAND');
        expect(result.decision?.targetStage).toBe('DISCOVER');
        expect(result.decision?.priority).toBe('DISCOVER');
        expect(result.decision?.quantities).toEqual([2, 2, 2]);
        expect(result.decision?.units).toEqual(['UNIT', 'KG', 'KG']);
        expect(result.decision?.deadlineHours).toBe(12);
        expect(result.decision?.stopConditions.length).toBeGreaterThan(0);
        const serialized = JSON.stringify(result.decision);
        expect(serialized).not.toMatch(
          /paymentAmount|paymentRecipient|fulfillmentState|allocationAmount|reconciliationAmount|supplierPrice|supplierIdentity|authorization|endpoint|https?:\/\//i
        );
      },
      45000
    );
  });
});
