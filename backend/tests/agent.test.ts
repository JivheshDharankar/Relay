import { describe, it, expect, beforeAll, vi } from 'vitest';
import { PrismaClient, AuditEventType } from '@prisma/client';
import request from 'supertest';
import { app } from '../src/app';
import { seed, SEED_IDS } from '../prisma/seed';
import { onboardFreshUser } from './helpers/onboardFreshUser';
import {
  RelayAgent,
  relayAgent,
  ToolRegistry,
  ToolExecutionError,
  MockModelProvider,
  MetaSparkProvider,
  SparkOpenProvider,
  getModelProvider,
  createRequestTool,
  checkAuthorizationTool,
  aggregateDemandTool,
  discoverSuppliersTool,
  evaluateOffersTool,
  selectOfferTool,
  createCommunityOrderTool,
  allocateResidentOrdersTool,
  reconcileOrderTool,
  requestPaymentTool,
  trackDeliveryTool,
} from '../src/agent';

const prisma = new PrismaClient();

describe('Milestone 4 — Relay Agent Layer + ModelProvider + Controlled Tools', () => {
  beforeAll(async () => {
    // Reset DB to clean deterministic seed state
    await seed(prisma);
  });

  // -------------------------------------------------------------------------
  // 1. MODEL PROVIDER ABSTRACTION
  // -------------------------------------------------------------------------
  describe('1. ModelProvider Abstraction', () => {
    it('MockModelProvider generates text and tool call responses deterministically', async () => {
      const mock = new MockModelProvider();
      const textResponse = await mock.generate({ messages: [{ role: 'user', content: 'Hello Relay' }] });
      expect(textResponse.content).toBeTruthy();
      expect(textResponse.finishReason).toBe('stop');

      const toolResponse = await mock.generateWithTools({
        messages: [{ role: 'user', content: 'I need 5L cooking oil' }],
        tools: [],
      });
      expect(toolResponse.toolCalls).toBeDefined();
      expect(toolResponse.toolCalls?.length).toBe(1);
      expect(toolResponse.toolCalls?.[0].name).toBe('createRequest');
      expect(toolResponse.finishReason).toBe('tool_calls');
    });

    it('MockModelProvider supports scripted test sequences for failure simulation', async () => {
      const scripted = new MockModelProvider([
        {
          toolCall: {
            id: 'call_custom_01',
            name: 'createRequest',
            arguments: { productId: SEED_IDS.products.rice, quantity: 10, unit: 'KG' },
          },
        },
        {
          content: 'Scripted completion after custom step.',
        },
      ]);

      const step1 = await scripted.generateWithTools({ messages: [], tools: [] });
      expect(step1.toolCalls?.[0].name).toBe('createRequest');

      const step2 = await scripted.generateWithTools({ messages: [], tools: [] });
      expect(step2.content).toBe('Scripted completion after custom step.');
      expect(step2.finishReason).toBe('stop');
    });

    it('MetaSparkProvider fails with META_API_KEY_MISSING when unconfigured', async () => {
      const meta = new MetaSparkProvider({ apiKey: '' });
      await expect(
        meta.generate({ messages: [{ role: 'user', content: 'Test' }] })
      ).rejects.toMatchObject({
        code: 'META_API_KEY_MISSING',
      });
    });

    it('SparkOpenProvider fails with SPARK_OPEN_UNAVAILABLE when endpoint is unreachable', async () => {
      const sparkOpen = new SparkOpenProvider({ endpoint: 'http://localhost:9999/v1' });
      await expect(
        sparkOpen.generate({ messages: [{ role: 'user', content: 'Test' }] })
      ).rejects.toMatchObject({
        code: 'SPARK_OPEN_UNAVAILABLE',
      });
    });

    it('SparkOpenProvider fails closed with SPARK_OPEN_TIMEOUT on a hung endpoint', async () => {
      const hangFetch = (async (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        })) as unknown as typeof fetch;
      vi.stubGlobal('fetch', hangFetch);
      try {
        const sparkOpen = new SparkOpenProvider({ timeoutMs: 50 });
        await expect(
          sparkOpen.generate({ messages: [{ role: 'user', content: 'Test' }] })
        ).rejects.toMatchObject({ code: 'SPARK_OPEN_TIMEOUT' });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('getModelProvider factory instantiates the requested or configured provider', () => {
      const mock = getModelProvider('mock');
      expect(mock.providerName).toBe('mock');

      const meta = getModelProvider('meta');
      expect(meta.providerName).toBe('meta-spark');

      const open = getModelProvider('spark-open');
      expect(open.providerName).toBe('spark-open');
    });
  });

  // -------------------------------------------------------------------------
  // 2. TOOL REGISTRY & STRICT VALIDATION
  // -------------------------------------------------------------------------
  describe('2. Tool Registry & Strict Validation', () => {
    it('registers and retrieves tools correctly', () => {
      const registry = new ToolRegistry();
      registry.register(createRequestTool);
      expect(registry.has('createRequest')).toBe(true);
      expect(registry.has('nonExistent')).toBe(false);
      expect(registry.get('createRequest')?.name).toBe('createRequest');
      expect(registry.list().length).toBe(1);
    });

    it('exposes OpenAI/Meta-compatible ToolDefinition schemas', () => {
      const registry = new ToolRegistry();
      registry.register(createRequestTool);
      registry.register(checkAuthorizationTool);

      const defs = registry.getDefinitions();
      expect(defs.length).toBe(2);
      expect(defs[0].name).toBe('createRequest');
      expect(defs[0].parameters.type).toBe('object');
      expect(defs[0].parameters.properties).toHaveProperty('quantity');
      expect(defs[0].parameters.properties).toHaveProperty('unit');
    });

    it('rejects execution of unregistered tools with UNKNOWN_TOOL error', async () => {
      const registry = new ToolRegistry();
      const ctx = {
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
      };

      await expect(
        registry.execute('unregisteredTool', {}, ctx)
      ).rejects.toMatchObject({
        code: 'UNKNOWN_TOOL',
      });
    });

    it('enforces strict Zod argument validation on missing or invalid types', async () => {
      const registry = new ToolRegistry();
      registry.register(createRequestTool);
      const ctx = {
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
      };

      // Missing required 'unit' and 'quantity'
      await expect(
        registry.execute('createRequest', {}, ctx)
      ).rejects.toMatchObject({
        code: 'INVALID_TOOL_ARGUMENT',
      });

      // Negative quantity violates schema
      await expect(
        registry.execute('createRequest', { quantity: -5, unit: 'LITRE' }, ctx)
      ).rejects.toMatchObject({
        code: 'INVALID_TOOL_ARGUMENT',
      });

      // Invalid unit enum
      await expect(
        registry.execute('createRequest', { quantity: 5, unit: 'BARRELS' }, ctx)
      ).rejects.toMatchObject({
        code: 'INVALID_TOOL_ARGUMENT',
      });
    });

    it('executes real execution tools (requestPayment & trackDelivery) with error handling', async () => {
      const ctx = {
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
      };

      await expect(
        requestPaymentTool.execute({ residentOrderId: 'non_existent_order_id' }, ctx)
      ).rejects.toMatchObject({
        code: 'RESIDENT_ORDER_NOT_FOUND',
      });

      await expect(
        trackDeliveryTool.execute({ communityOrderId: 'non_existent_comm_order' }, ctx)
      ).rejects.toMatchObject({
        code: 'COMMUNITY_ORDER_NOT_FOUND',
      });
    });
  });

  // -------------------------------------------------------------------------
  // 3. CONTROLLED TOOLS INDIVIDUAL EXECUTION
  // -------------------------------------------------------------------------
  describe('3. Controlled Tools Individual Execution', () => {
    it('createRequest tool records a valid resident procurement demand', async () => {
      const ctx = {
        residentId: SEED_IDS.residents.neel,
        societyId: SEED_IDS.society.greenview,
      };

      const result = await createRequestTool.execute(
        {
          quantity: 2.0,
          unit: 'LITRE',
          productId: SEED_IDS.products.cookingOil,
        },
        ctx
      );

      expect(result.success).toBe(true);
      expect(result.orderId).toBeDefined();
      expect(result.totalPrice).toBe(330); // 2L * 165
    });

    it('checkAuthorization tool verifies resident mandate limit', async () => {
      const ctx = {
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
      };

      // Under limit: Aarav has 5000 mandate limit
      const authResult = await checkAuthorizationTool.execute(
        { requestedAmount: 825.0, purpose: 'Cooking Oil' },
        ctx
      );
      expect(authResult.authorized).toBe(true);
      expect(authResult.mandateId).toBe(SEED_IDS.mandates.aarav);

      // Over limit: should fail authorization deterministically
      const overAuthResult = await checkAuthorizationTool.execute(
        { requestedAmount: 99999.0, purpose: 'Yacht' },
        ctx
      );
      expect(overAuthResult.authorized).toBe(false);
      expect(overAuthResult.code).toBe('REJECTED');
      expect(overAuthResult.reason).toContain('MANDATE_LIMIT_EXCEEDED');
    });

    it('aggregateDemand tool strictly anonymizes resident data for suppliers', async () => {
      const ctx = {
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
      };

      const result = await aggregateDemandTool.execute({}, ctx);
      expect(result.success).toBe(true);
      expect(result.supplierFacingGroups).toBeDefined();
      expect(result.supplierFacingGroups.length).toBeGreaterThan(0);

      // Invariant: Supplier facing groups must NOT contain resident names, flats, or emails
      for (const group of result.supplierFacingGroups) {
        expect(group).not.toHaveProperty('residentName');
        expect(group).not.toHaveProperty('flatNumber');
        expect(group).not.toHaveProperty('email');
        expect(group).toHaveProperty('productName');
        expect(group).toHaveProperty('totalQuantity');
      }
    });

    it('discoverSuppliers tool filters suppliers by 12h SLA and service radius', async () => {
      const ctx = {
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
      };

      const result = await discoverSuppliersTool.execute(
        { productId: SEED_IDS.products.cookingOil, requestedQuantity: 5.0, maxSlaHours: 12.0 },
        ctx
      );

      expect(result.success).toBe(true);
      expect(result.qualifiedCount).toBeGreaterThan(0);
      expect(result.suppliers.length).toBeGreaterThan(0);
      for (const sup of result.suppliers.filter((s: any) => s.eligible)) {
        expect(sup.deliverySlaHours).toBeLessThanOrEqual(12.0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 4. RELAY AGENT ORCHESTRATION & SAFETY BOUNDARIES
  // -------------------------------------------------------------------------
  describe('4. Relay Agent Orchestration & Safety Boundaries', () => {
    it('executes within a bounded loop and terminates when model returns finishReason=stop', async () => {
      const scriptedProvider = new MockModelProvider([
        {
          content: 'Hello! I am Relay, your community procurement coordinator.',
        },
      ]);

      const agent = new RelayAgent({ modelProvider: scriptedProvider });
      const result = await agent.run({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        message: 'Hello',
      });

      // Terminates after one step with the response preserved — but a stop
      // before ANY tool ran is a blocked run, never a completed procurement.
      expect(result.totalSteps).toBe(1);
      expect(result.response).toContain('Hello! I am Relay');
      expect(result.success).toBe(false);
      expect(result.completed).toBe(false);
      expect(result.error?.code).toBe('UNMAPPABLE_PRODUCT');
    });

    it('enforces maximum step boundary and halts with AGENT_STEP_LIMIT_EXCEEDED', async () => {
      // Infinite loop simulation: tool calls itself continuously
      const loopingProvider = new MockModelProvider();
      loopingProvider.setSequence([
        { toolCall: { id: 'c1', name: 'checkAuthorization', arguments: { requestedAmount: 100 } } },
        { toolCall: { id: 'c2', name: 'checkAuthorization', arguments: { requestedAmount: 100 } } },
        { toolCall: { id: 'c3', name: 'checkAuthorization', arguments: { requestedAmount: 100 } } },
        { toolCall: { id: 'c4', name: 'checkAuthorization', arguments: { requestedAmount: 100 } } },
        { toolCall: { id: 'c5', name: 'checkAuthorization', arguments: { requestedAmount: 100 } } },
      ]);

      const agent = new RelayAgent({
        modelProvider: loopingProvider,
        maxSteps: 3, // Strict limit
      });

      const result = await agent.run({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        message: 'Looping request',
      });

      expect(result.success).toBe(false);
      expect(result.completed).toBe(false);
      expect(result.error?.code).toBe('AGENT_STEP_LIMIT_EXCEEDED');
      expect(result.totalSteps).toBe(3);
    });

    it('handles tool execution errors gracefully and returns them to the agent', async () => {
      const errorRecoveryProvider = new MockModelProvider([
        // Step 1: Deliberately issue malformed arguments
        {
          toolCall: {
            id: 'c_fail',
            name: 'createRequest',
            arguments: { quantity: -50, unit: 'INVALID_UNIT' },
          },
        },
        // Step 2: Agent acknowledges error and stops safely
        {
          content: 'Procurement stopped: Invalid request parameters provided.',
        },
      ]);

      const agent = new RelayAgent({ modelProvider: errorRecoveryProvider });
      const result = await agent.run({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        message: 'Order with bad params',
      });

      // A run whose every tool call errored accomplished nothing: it must
      // report blocked (success/completed false) with the classified tool
      // error — reporting success here was a false victory. Graceful
      // handling (error returned to the model, steps + message preserved)
      // is unchanged.
      expect(result.success).toBe(false);
      expect(result.completed).toBe(false);
      expect(result.error?.code).toBe('INVALID_TOOL_ARGUMENT');
      expect(result.steps.length).toBe(2);
      expect(result.steps[0].toolCall?.error).toBeDefined();
      expect(result.response).toContain('Procurement stopped');
    });

    it('reports blocked with the classified gate code when every tool call errors', async () => {
      // Final hardening: an intent-gate rejection (no tool success) must
      // surface the gate code — never success:true, never a generic code.
      // (The hermetic mock provider classifies this input UNMAPPABLE; the
      // Meta path classifies it MISSING_QUANTITY. Both flow through the
      // same first-tool-error propagation pinned here.)
      const gateProvider = new MockModelProvider([
        {
          toolCall: {
            id: 'c_gate',
            name: 'startWorkflow',
            arguments: {
              requestText: 'I need some milk please',
              residentReference: SEED_IDS.residents.aarav,
              societyReference: SEED_IDS.society.greenview,
            },
          },
        },
        {
          content: 'How much milk do you need?',
        },
      ]);

      const agent = new RelayAgent({ modelProvider: gateProvider });
      const result = await agent.run({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        message: 'I need some milk please',
      });

      expect(result.success).toBe(false);
      expect(result.completed).toBe(false);
      expect(result.error?.code).toBe('UNMAPPABLE_PRODUCT');
      expect(result.steps.length).toBe(2);
      expect(result.steps[0].toolCall?.error).toBeDefined();
    });

    it('records operational audit ledger entries without leaking internal model thoughts', async () => {
      const mockProvider = new MockModelProvider([
        {
          content: 'Checking authorization before purchase',
          toolCall: {
            id: 'c_auth',
            name: 'checkAuthorization',
            arguments: { requestedAmount: 500, purpose: 'Groceries' },
          },
        },
        {
          content: 'Authorization check completed.',
        },
      ]);

      const agent = new RelayAgent({ modelProvider: mockProvider });
      const runResult = await agent.run({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        message: 'Check my mandate',
      });

      expect(runResult.success).toBe(true);

      // Verify audit events were written
      const auditEvents = await prisma.auditEvent.findMany({
        where: {
          OR: [
            { entityId: runResult.runId },
            { metadata: { path: ['runId'], equals: runResult.runId } },
          ],
        },
        orderBy: { createdAt: 'asc' },
      });

      expect(auditEvents.length).toBeGreaterThan(0);
      const eventTypes = auditEvents.map((e) => e.eventType);
      expect(eventTypes).toContain(AuditEventType.AGENT_REQUEST_RECEIVED);
      expect(eventTypes).toContain(AuditEventType.AGENT_TOOL_CALLED);
      expect(eventTypes).toContain(AuditEventType.AGENT_TOOL_SUCCEEDED);
      expect(eventTypes).toContain(AuditEventType.AGENT_WORKFLOW_COMPLETED);
    });
  });

  // -------------------------------------------------------------------------
  // 5. AUTONOMOUS END-TO-END PROCUREMENT SCENARIO
  // -------------------------------------------------------------------------
  describe('5. Autonomous End-to-End Procurement Flow', () => {
    it('executes full 10-step autonomous procurement from prompt to reconciliation', async () => {
      const mockProvider = new MockModelProvider();
      mockProvider.reset();

      const agent = new RelayAgent({ modelProvider: mockProvider, maxSteps: 20 });

      const prompt =
        'I need 5 litres of sunflower cooking oil delivered to flat Tower A-101 within 12 hours under my pre-authorized mandate.';

      const result = await agent.run({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        message: prompt,
      });

      expect(result.success).toBe(true);
      expect(result.completed).toBe(true);
      expect(result.totalSteps).toBe(10);
      expect(result.response).toContain('Relay autonomous procurement is complete');
      expect(result.response).toContain('5L Sunflower Cooking Oil');

      // Verify the 9 tools were executed in exact sequential order
      const executedToolNames = result.steps
        .filter((s) => s.toolCall)
        .map((s) => s.toolCall!.name);

      expect(executedToolNames).toEqual([
        'createRequest',
        'checkAuthorization',
        'aggregateDemand',
        'discoverSuppliers',
        'evaluateOffers',
        'selectOffer',
        'createCommunityOrder',
        'allocateResidentOrders',
        'reconcileOrder',
      ]);

      // Verify created order exists in database and is fully reconciled
      const reconcileStep = result.steps.find((s) => s.toolCall?.name === 'reconcileOrder');
      expect(reconcileStep?.toolCall?.result).toMatchObject({
        isReconciled: true,
        status: 'RECONCILED',
      });
    });
  });

  // -------------------------------------------------------------------------
  // 6. DEVELOPMENT API ENDPOINT (POST /api/agent/run)
  // -------------------------------------------------------------------------
  describe('6. API Endpoint: POST /api/agent/run', () => {
    it('rejects unauthenticated run requests with 401 (no anonymous procurement)', async () => {
      const res = await request(app)
        .post('/api/agent/run')
        .send({
          residentId: SEED_IDS.residents.aarav,
          societyId: SEED_IDS.society.greenview,
          message: 'I need 5 litres of sunflower cooking oil within 12 hours.',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 400 when message is missing or invalid', async () => {
      const { userService, sessionService } = await import('../src/identity');
      const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: `ep_agent400_${suffix}`,
        email: `agent400_${suffix}@relay.local`,
        name: 'Agent 400 User',
      });
      const session = await sessionService.createSession(user.id);

      const res = await request(app)
        .post('/api/agent/run')
        .set('Authorization', `Bearer ${session.token}`)
        .send({ societyId: SEED_IDS.society.greenview });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });

    it('triggers the agent workflow via API and returns 200 with result', async () => {
      const u = await onboardFreshUser({
        emailPrefix: 'agent.run',
        societyName: 'Agent Run Heights',
        mandateLimit: 10000,
      });

      const res = await request(app)
        .post('/api/agent/run')
        .set('Authorization', `Bearer ${u.token}`)
        .send({
          message: 'I need 5 litres of sunflower cooking oil within 12 hours.',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.completed).toBe(true);
      expect(res.body.runId).toBeDefined();
      expect(res.body.steps.length).toBeGreaterThan(0);
      expect(res.body.response).toContain('Relay autonomous procurement is complete');
    });
  });
});
