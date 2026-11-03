import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import {
  PrismaClient,
  ProductUnit,
  DeliveryStatus,
  CommunityOrderStatus,
  PaymentStatus,
  ResidentOrderStatus,
  PaymentMandateStatus,
  AuditEventType,
} from '@prisma/client';
import { app } from '../src/app';
import { seed, SEED_IDS } from '../prisma/seed';
import {
  requestService,
  authorizationService,
  aggregationService,
  supplierService,
  offerService,
  orderService,
  allocationService,
  reconciliationService,
} from '../src/services/procurement';
import { executionService, mockPaymentProvider, mockSupplierProvider } from '../src/execution';
import { DeliverySimulator } from '../src/execution/delivery/DeliverySimulator';
import { RelayAgent } from '../src/agent/relayAgent';
import { toolRegistry } from '../src/agent/tools';
import { MockModelProvider } from '../src/agent/model/MockModelProvider';
import { toDecimal } from '../src/domain/procurement';

const prisma = new PrismaClient();

describe('Milestone 8 — Hardening & Reliability Verification Suite', () => {
  beforeAll(async () => {
    // Fresh idempotent seed
    await seed(prisma);
  });

  // ---------------------------------------------------------------------------
  // 1. AGENT SAFETY & ADVERSARIAL INPUT DEFENSE
  // ---------------------------------------------------------------------------
  describe('1. Agent Safety & Boundaries', () => {
    it('enforces maximum agent step limit and halts safely', async () => {
      // A provider that keeps issuing tool calls past the agent's step budget.
      // Uses the real scripted-sequence API (more calls than maxSteps); it must
      // NOT rely on the mock's unmatched-prompt path, which honestly stops.
      const loopingProvider = new MockModelProvider();
      loopingProvider.setSequence(
        Array.from({ length: 5 }, (_, i) => ({
          content: 'looping',
          toolCall: {
            id: `call_loop_${i}`,
            name: 'checkAuthorization',
            arguments: { requestedAmount: 100.0 },
          },
        })),
      );

      const boundedAgent = new RelayAgent({
        modelProvider: loopingProvider,
        toolRegistry,
        maxSteps: 3, // Constrain to 3 steps for safety test
      });

      const result = await boundedAgent.run({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        message: 'Looping agent test',
      });

      expect(result.success).toBe(false);
      expect(result.completed).toBe(false);
      expect(result.totalSteps).toBe(3);
      expect(result.error?.code).toBe('AGENT_STEP_LIMIT_EXCEEDED');
    });

    it('rejects unknown tool invocations safely with UNKNOWN_TOOL', async () => {
      await expect(
        toolRegistry.execute(
          'nonExistentHackerTool',
          { maliciousArg: 'test' },
          {
            residentId: SEED_IDS.residents.aarav,
            societyId: SEED_IDS.society.greenview,
            runId: 'test-run',
          }
        )
      ).rejects.toMatchObject({
        code: 'UNKNOWN_TOOL',
      });
    });

    it('rejects malformed tool arguments via strict Zod schema validation', async () => {
      await expect(
        toolRegistry.execute(
          'createRequest',
          { quantity: -10, unit: 'LITRE' }, // Negative quantity violates schema
          {
            residentId: SEED_IDS.residents.aarav,
            societyId: SEED_IDS.society.greenview,
            runId: 'test-run',
          }
        )
      ).rejects.toMatchObject({
        code: 'INVALID_TOOL_ARGUMENT',
      });
    });

    it('REST API /api/agent/run rejects empty, whitespace, or oversized prompts', async () => {
      const { userService, sessionService } = await import('../src/identity');
      const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: `ep_hardrun_${suffix}`,
        email: `hardrun_${suffix}@relay.local`,
        name: 'Hardening Run User',
      });
      const session = await sessionService.createSession(user.id);
      const auth = { Authorization: `Bearer ${session.token}` };

      // Empty message
      const emptyRes = await request(app)
        .post('/api/agent/run')
        .set(auth)
        .send({ message: '' });
      expect(emptyRes.status).toBe(400);
      expect(emptyRes.body.error.code).toBe('INVALID_REQUEST');

      // Whitespace only
      const whitespaceRes = await request(app)
        .post('/api/agent/run')
        .set(auth)
        .send({ message: '   \n  \t  ' });
      expect(whitespaceRes.status).toBe(400);
      expect(whitespaceRes.body.error.code).toBe('INVALID_REQUEST');

      // Oversized prompt (> 5000 chars)
      const oversizedRes = await request(app)
        .post('/api/agent/run')
        .set(auth)
        .send({ message: 'A'.repeat(5001) });
      expect(oversizedRes.status).toBe(400);
      expect(oversizedRes.body.error.code).toBe('REQUEST_TOO_LARGE');

      // Anonymous callers are rejected before validation (no procurement).
      const anonRes = await request(app)
        .post('/api/agent/run')
        .send({ message: 'I need 1 kg rice' });
      expect(anonRes.status).toBe(401);
      expect(anonRes.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. AUTHORIZATION HARDENING & CEILING BOUNDARIES
  // ---------------------------------------------------------------------------
  describe('2. Authorization Hardening', () => {
    it('verifies boundary conditions: below ceiling (<), exact ceiling (==), above ceiling (>)', async () => {
      // Aarav mandate ceiling is ₹8,000.00
      const mandate = await prisma.paymentMandate.findFirst({
        where: { residentId: SEED_IDS.residents.aarav, status: 'ACTIVE' },
      });
      expect(mandate).toBeDefined();
      const ceiling = Number(mandate!.maximumAmount);

      // Case A: Below ceiling (₹7,999.00) -> Authorized
      const belowRes = await authorizationService.checkAuthorization({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        requestedAmount: ceiling - 1.0,
        mandateId: mandate!.id,
      });
      expect(belowRes.authorized).toBe(true);
      expect(belowRes.code).toBe('AUTHORIZED');

      // Case B: Exact ceiling (₹8,000.00) -> Authorized
      const exactRes = await authorizationService.checkAuthorization({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        requestedAmount: ceiling,
        mandateId: mandate!.id,
      });
      expect(exactRes.authorized).toBe(true);
      expect(exactRes.code).toBe('AUTHORIZED');

      // Case C: Above ceiling (₹8,000.01) -> Rejected
      const aboveRes = await authorizationService.checkAuthorization({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        requestedAmount: ceiling + 0.01,
        mandateId: mandate!.id,
      });
      expect(aboveRes.authorized).toBe(false);
      expect(aboveRes.code).toBe('REJECTED');
      expect(aboveRes.reason).toContain('MANDATE_LIMIT_EXCEEDED');
    });

    it('rejects expired mandates deterministically', async () => {
      // Create an expired mandate for testing
      const expired = await prisma.paymentMandate.create({
        data: {
          residentId: SEED_IDS.residents.aarav,
          status: PaymentMandateStatus.ACTIVE,
          maximumAmount: 5000.0,
          currency: 'INR',
          purpose: 'Expired Mandate Test',
          periodStart: new Date(Date.now() - 30 * 86400 * 1000),
          periodEnd: new Date(Date.now() - 1 * 86400 * 1000), // Expired yesterday
        },
      });

      const res = await authorizationService.checkAuthorization({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        requestedAmount: 100.0,
        mandateId: expired.id,
      });

      expect(res.authorized).toBe(false);
      expect(res.reason).toBe('MANDATE_PERIOD_EXPIRED');

      // Cleanup
      await prisma.paymentMandate.delete({ where: { id: expired.id } });
    });

    it('rejects inactive or revoked mandates deterministically', async () => {
      const revoked = await prisma.paymentMandate.create({
        data: {
          residentId: SEED_IDS.residents.aarav,
          status: PaymentMandateStatus.REVOKED,
          maximumAmount: 5000.0,
          currency: 'INR',
          purpose: 'Revoked Mandate Test',
          periodStart: new Date(),
        },
      });

      const res = await authorizationService.checkAuthorization({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        requestedAmount: 100.0,
        mandateId: revoked.id,
      });

      expect(res.authorized).toBe(false);
      expect(res.reason).toContain('MANDATE_INACTIVE');

      // Cleanup
      await prisma.paymentMandate.delete({ where: { id: revoked.id } });
    });

    it('prevents cross-resident mandate theft: resident cannot use another residents mandate', async () => {
      // Riya's mandate
      const riyaMandate = await prisma.paymentMandate.findFirst({
        where: { residentId: SEED_IDS.residents.riya },
      });
      expect(riyaMandate).toBeDefined();

      // Aarav attempts to authorize an order using Riya's mandate
      await expect(
        authorizationService.checkAuthorization({
          residentId: SEED_IDS.residents.aarav,
          societyId: SEED_IDS.society.greenview,
          requestedAmount: 500.0,
          mandateId: riyaMandate!.id,
        })
      ).rejects.toThrow(/does not belong to resident/i);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. PAYMENT HARDENING & CONCURRENCY
  // ---------------------------------------------------------------------------
  describe('3. Payment Hardening & Concurrency', () => {
    it('rejects payment when requested amount does not match order total (AMOUNT_MISMATCH)', async () => {
      const validated = await requestService.validateRequest({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.cookingOil,
        quantity: 5.0,
        unit: ProductUnit.LITRE,
        deliveryAddress: 'Tower A-101',
      });
      const order = await requestService.createResidentOrder(validated);

      // Order total is ₹825.00, attempt to pay ₹500.00
      await expect(
        executionService.executeResidentPayment({
          residentOrderId: order.id,
          amount: 500.0,
          idempotencyKey: `IDEMP-MISMATCH-${order.id}`,
        })
      ).rejects.toMatchObject({
        code: 'AMOUNT_MISMATCH',
      });
    });

    it('returns existing payment and prevents double-charge on already-paid orders', async () => {
      const validated = await requestService.validateRequest({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.cookingOil,
        quantity: 5.0,
        unit: ProductUnit.LITRE,
        deliveryAddress: 'Tower A-101',
      });
      const order = await requestService.createResidentOrder(validated);

      // First payment execution
      const pay1 = await executionService.executeResidentPayment({
        residentOrderId: order.id,
        idempotencyKey: `IDEMP-PAID-${order.id}`,
      });
      expect(pay1.success).toBe(true);
      expect(pay1.residentOrderStatus).toBe(ResidentOrderStatus.PAID);

      // Second payment execution with DIFFERENT idempotency key
      const pay2 = await executionService.executeResidentPayment({
        residentOrderId: order.id,
        idempotencyKey: `IDEMP-SECOND-ATTEMPT-${order.id}`,
      });

      expect(pay2.success).toBe(true);
      expect(pay2.payment.isDuplicate).toBe(true);
      expect(pay2.payment.providerReference).toBe(pay1.payment.providerReference);

      // Verify in Postgres: exactly 1 payment record exists for this order
      const count = await prisma.payment.count({
        where: { residentOrderId: order.id, status: PaymentStatus.SUCCESS },
      });
      expect(count).toBe(1);
    });

    it('concurrency test: simultaneous concurrent payment calls result in exactly 1 successful charge', async () => {
      const validated = await requestService.validateRequest({
        residentId: SEED_IDS.residents.riya,
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.cookingOil,
        quantity: 5.0,
        unit: ProductUnit.LITRE,
        deliveryAddress: 'Tower B-202',
      });
      const order = await requestService.createResidentOrder(validated);

      // Trigger 4 simultaneous concurrent payment calls
      const concurrentResults = await Promise.all([
        executionService.executeResidentPayment({
          residentOrderId: order.id,
          idempotencyKey: `CONCURRENT-PAY-1-${order.id}`,
        }),
        executionService.executeResidentPayment({
          residentOrderId: order.id,
          idempotencyKey: `CONCURRENT-PAY-2-${order.id}`,
        }),
        executionService.executeResidentPayment({
          residentOrderId: order.id,
          idempotencyKey: `CONCURRENT-PAY-3-${order.id}`,
        }),
        executionService.executeResidentPayment({
          residentOrderId: order.id,
          idempotencyKey: `CONCURRENT-PAY-4-${order.id}`,
        }),
      ]);

      // All 4 calls should resolve successfully
      for (const res of concurrentResults) {
        expect(res.success).toBe(true);
        expect(res.residentOrderStatus).toBe(ResidentOrderStatus.PAID);
      }

      // Verify in Postgres: exactly ONE payment record was written
      const payments = await prisma.payment.findMany({
        where: { residentOrderId: order.id, status: PaymentStatus.SUCCESS },
      });
      expect(payments.length).toBe(1);

      // Verify all callers received the exact same provider reference
      const providerRef = payments[0].providerReference;
      for (const res of concurrentResults) {
        expect(res.payment.providerReference).toBe(providerRef);
      }
    });

    it('recovers cleanly from payment provider downtime without corrupting order state', async () => {
      const validated = await requestService.validateRequest({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.rice,
        quantity: 5.0,
        unit: ProductUnit.KG,
        deliveryAddress: 'Tower A-101',
      });
      const order = await requestService.createResidentOrder(validated);

      // Simulate provider downtime
      mockPaymentProvider.setUnavailable(true);

      await expect(
        executionService.executeResidentPayment({
          residentOrderId: order.id,
          idempotencyKey: `IDEMP-DOWN-${order.id}`,
        })
      ).rejects.toMatchObject({
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
      });

      // Verify order is NOT marked PAID
      const orderAfterFail = await prisma.residentOrder.findUnique({
        where: { id: order.id },
      });
      expect(orderAfterFail!.status).not.toBe(ResidentOrderStatus.PAID);

      // Restore provider and retry -> succeeds
      mockPaymentProvider.setUnavailable(false);

      const retryRes = await executionService.executeResidentPayment({
        residentOrderId: order.id,
        idempotencyKey: `IDEMP-RETRY-${order.id}`,
      });
      expect(retryRes.success).toBe(true);
      expect(retryRes.residentOrderStatus).toBe(ResidentOrderStatus.PAID);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. ORDER IDEMPOTENCY & CONCURRENCY
  // ---------------------------------------------------------------------------
  describe('4. Order Idempotency & Concurrency', () => {
    it('simultaneous concurrent community order creation with same idempotency key succeeds cleanly', async () => {
      const sharedKey = `CONCURRENT-COMMUNITY-${Date.now()}`;
      const deadline = new Date(Date.now() + 6 * 3600 * 1000);

      const [res1, res2, res3] = await Promise.all([
        orderService.createCommunityOrder({
          societyId: SEED_IDS.society.greenview,
          supplierId: SEED_IDS.suppliers.sahyadri,
          deliveryDeadline: deadline,
          idempotencyKey: sharedKey,
          items: [
            {
              productId: SEED_IDS.products.cookingOil,
              totalQuantity: 5.0,
              negotiatedUnitPrice: 165.0,
            },
          ],
        }),
        orderService.createCommunityOrder({
          societyId: SEED_IDS.society.greenview,
          supplierId: SEED_IDS.suppliers.sahyadri,
          deliveryDeadline: deadline,
          idempotencyKey: sharedKey,
          items: [
            {
              productId: SEED_IDS.products.cookingOil,
              totalQuantity: 5.0,
              negotiatedUnitPrice: 165.0,
            },
          ],
        }),
        orderService.createCommunityOrder({
          societyId: SEED_IDS.society.greenview,
          supplierId: SEED_IDS.suppliers.sahyadri,
          deliveryDeadline: deadline,
          idempotencyKey: sharedKey,
          items: [
            {
              productId: SEED_IDS.products.cookingOil,
              totalQuantity: 5.0,
              negotiatedUnitPrice: 165.0,
            },
          ],
        }),
      ]);

      expect(res1.order.id).toBe(res2.order.id);
      expect(res2.order.id).toBe(res3.order.id);

      // Exactly 1 community order with this idempotency key in database
      const count = await prisma.communityOrder.count({
        where: { idempotencyKey: sharedKey },
      });
      expect(count).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. PROCUREMENT HARD CONSTRAINTS
  // ---------------------------------------------------------------------------
  describe('5. Procurement Hard Constraints', () => {
    it('disqualifies suppliers outside service radius (SERVICE_AREA_EXCEEDED)', async () => {
      // Temporarily set Sahyadri service radius to 1.0 km (Greenview is ~14 km away)
      await prisma.supplier.update({
        where: { id: SEED_IDS.suppliers.sahyadri },
        data: { serviceRadiusKm: 1.0 },
      });

      const evaluations = await supplierService.filterEligibleSuppliers({
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.cookingOil,
        requestedQuantity: 10.0,
      });

      const sahyadri = evaluations.find((e) => e.supplierId === SEED_IDS.suppliers.sahyadri);
      expect(sahyadri).toBeDefined();
      expect(sahyadri!.eligible).toBe(false);
      expect(sahyadri!.reasons.some((r) => r.includes('SERVICE_AREA_EXCEEDED'))).toBe(true);

      // Restore service radius
      await prisma.supplier.update({
        where: { id: SEED_IDS.suppliers.sahyadri },
        data: { serviceRadiusKm: 15.0 },
      });
    });

    it('disqualifies suppliers exceeding 12-hour fulfillment SLA (SLA_VIOLATION)', async () => {
      const evaluations = await supplierService.filterEligibleSuppliers({
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.cookingOil,
        requestedQuantity: 10.0,
        overrideDeliveryHours: {
          [SEED_IDS.suppliers.sahyadri]: 16, // Violates 12h SLA
        },
      });

      const sahyadri = evaluations.find((e) => e.supplierId === SEED_IDS.suppliers.sahyadri);
      expect(sahyadri!.eligible).toBe(false);
      expect(sahyadri!.reasons.some((r) => r.includes('SLA_VIOLATION'))).toBe(true);
    });

    it('disqualifies suppliers when order quantity is below MOQ (MOQ_NOT_MET)', async () => {
      // Request 0.5 kg of rice when supplier MOQs are at least 1.0 kg (Deccan 1kg, Sahyadri 20kg, PuneBulk 25kg)
      const evaluations = await supplierService.filterEligibleSuppliers({
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.rice,
        requestedQuantity: 0.5,
      });

      for (const ev of evaluations) {
        expect(ev.eligible).toBe(false);
        expect(ev.reasons.some((r) => r.includes('MOQ_NOT_MET'))).toBe(true);
      }
    });

    it('applies hard constraints before scoring and rejects non-compliant suppliers', async () => {
      await expect(
        offerService.selectBestOffer({
          societyId: SEED_IDS.society.greenview,
          productId: SEED_IDS.products.rice,
          totalQuantity: 0.5, // Below all MOQs
        })
      ).rejects.toMatchObject({
        code: 'NO_ELIGIBLE_SUPPLIER',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 6. ALLOCATION INVARIANTS & TERMINAL LOCK
  // ---------------------------------------------------------------------------
  describe('6. Allocation Invariants', () => {
    it('verifies allocation arithmetic and supports fractional Decimal quantities', async () => {
      // Create community order for 5.0 L
      const commOrder = await prisma.communityOrder.create({
        data: {
          societyId: SEED_IDS.society.greenview,
          supplierId: SEED_IDS.suppliers.sahyadri,
          status: CommunityOrderStatus.CREATED,
          totalAmount: 825.0,
          currency: 'INR',
          deliveryDeadline: new Date(Date.now() + 6 * 3600 * 1000),
          items: {
            create: [
              {
                productId: SEED_IDS.products.cookingOil,
                totalQuantity: 5.0,
                negotiatedUnitPrice: 165.0,
                totalPrice: 825.0,
              },
            ],
          },
        },
      });

      // Allocate: 2.5 L + 2.5 L = 5.0 L
      const delivery = await allocationService.allocateCommunityDelivery({
        communityOrderId: commOrder.id,
        allocations: [
          {
            residentOrderId: SEED_IDS.residentOrders.orderAarav,
            productId: SEED_IDS.products.cookingOil,
            quantity: 2.5,
          },
          {
            residentOrderId: SEED_IDS.residentOrders.orderRiya,
            productId: SEED_IDS.products.cookingOil,
            quantity: 2.5,
          },
        ],
      });

      expect(delivery).toBeDefined();
      expect(delivery?.allocations.length).toBe(2);
      const totalAllocated = delivery?.allocations.reduce(
        (sum, a) => sum + Number(a.quantity),
        0
      );
      expect(totalAllocated).toBe(5.0);
    });

    it('rejects allocation when sum of resident quantities does not match community total (ALLOCATION_MISMATCH)', async () => {
      const commOrder = await prisma.communityOrder.create({
        data: {
          societyId: SEED_IDS.society.greenview,
          supplierId: SEED_IDS.suppliers.sahyadri,
          status: CommunityOrderStatus.CREATED,
          totalAmount: 825.0,
          currency: 'INR',
          deliveryDeadline: new Date(Date.now() + 6 * 3600 * 1000),
          items: {
            create: [
              {
                productId: SEED_IDS.products.cookingOil,
                totalQuantity: 5.0,
                negotiatedUnitPrice: 165.0,
                totalPrice: 825.0,
              },
            ],
          },
        },
      });

      // Attempt to allocate 4.0 L for a 5.0 L order
      await expect(
        allocationService.allocateCommunityDelivery({
          communityOrderId: commOrder.id,
          allocations: [
            {
              residentOrderId: SEED_IDS.residentOrders.orderAarav,
              productId: SEED_IDS.products.cookingOil,
              quantity: 4.0,
            },
          ],
        })
      ).rejects.toMatchObject({
        code: 'ALLOCATION_MISMATCH',
      });
    });

    it('rejects allocation on community order in terminal status RECONCILED', async () => {
      const reconciledOrder = await prisma.communityOrder.create({
        data: {
          societyId: SEED_IDS.society.greenview,
          supplierId: SEED_IDS.suppliers.sahyadri,
          status: CommunityOrderStatus.RECONCILED,
          totalAmount: 825.0,
          currency: 'INR',
          deliveryDeadline: new Date(Date.now() + 6 * 3600 * 1000),
          items: {
            create: [
              {
                productId: SEED_IDS.products.cookingOil,
                totalQuantity: 5.0,
                negotiatedUnitPrice: 165.0,
                totalPrice: 825.0,
              },
            ],
          },
        },
      });

      await expect(
        allocationService.allocateCommunityDelivery({
          communityOrderId: reconciledOrder.id,
          allocations: [
            {
              residentOrderId: SEED_IDS.residentOrders.orderAarav,
              productId: SEED_IDS.products.cookingOil,
              quantity: 5.0,
            },
          ],
        })
      ).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });
    });

    it('rejects zero or negative allocation quantities', async () => {
      const commOrder = await prisma.communityOrder.create({
        data: {
          societyId: SEED_IDS.society.greenview,
          supplierId: SEED_IDS.suppliers.sahyadri,
          status: CommunityOrderStatus.CREATED,
          totalAmount: 825.0,
          currency: 'INR',
          deliveryDeadline: new Date(Date.now() + 6 * 3600 * 1000),
          items: {
            create: [
              {
                productId: SEED_IDS.products.cookingOil,
                totalQuantity: 5.0,
                negotiatedUnitPrice: 165.0,
                totalPrice: 825.0,
              },
            ],
          },
        },
      });

      await expect(
        allocationService.allocateCommunityDelivery({
          communityOrderId: commOrder.id,
          allocations: [
            {
              residentOrderId: SEED_IDS.residentOrders.orderAarav,
              productId: SEED_IDS.products.cookingOil,
              quantity: -2.0,
            },
          ],
        })
      ).rejects.toMatchObject({
        code: 'INVALID_QUANTITY',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 7. RECONCILIATION HARDENING & DISCREPANCY RECORDING
  // ---------------------------------------------------------------------------
  describe('7. Reconciliation Hardening', () => {
    it('detects quantity discrepancy, marks FAILED, and records audit event with discrepancies', async () => {
      // Create community order for 5L
      const commOrder = await prisma.communityOrder.create({
        data: {
          societyId: SEED_IDS.society.greenview,
          supplierId: SEED_IDS.suppliers.sahyadri,
          status: CommunityOrderStatus.DELIVERED,
          totalAmount: 825.0,
          currency: 'INR',
          deliveryDeadline: new Date(Date.now() + 6 * 3600 * 1000),
          items: {
            create: [
              {
                productId: SEED_IDS.products.cookingOil,
                totalQuantity: 5.0,
                negotiatedUnitPrice: 165.0,
                totalPrice: 825.0,
              },
            ],
          },
          delivery: {
            create: {
              status: DeliveryStatus.DELIVERED,
              trackingCode: 'TRK-RECON-TEST',
              allocations: {
                create: [
                  {
                    residentOrderId: SEED_IDS.residentOrders.orderAarav,
                    productId: SEED_IDS.products.cookingOil,
                    quantity: 4.0, // Discrepancy: 4L allocated instead of 5L
                  },
                ],
              },
            },
          },
        },
      });

      const report = await reconciliationService.reconcileCommunityOrder(commOrder.id);

      expect(report.isReconciled).toBe(false);
      expect(report.status).toBe('FAILED');
      expect(report.quantityReconciliation.passed).toBe(false);
      expect(report.discrepancies.length).toBeGreaterThan(0);

      // Verify audit event recorded failure with discrepancies
      const audit = await prisma.auditEvent.findFirst({
        where: {
          entityId: commOrder.id,
          eventType: AuditEventType.RECONCILED,
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(audit).toBeDefined();
      expect((audit!.metadata as any).reconciled).toBe(false);
      expect((audit!.metadata as any).discrepancies.length).toBeGreaterThan(0);
    });

    it('detects financial mismatch between community invoice and resident orders', async () => {
      // Community order total is ₹1,000, but resident order total is ₹825
      const commOrder = await prisma.communityOrder.create({
        data: {
          societyId: SEED_IDS.society.greenview,
          supplierId: SEED_IDS.suppliers.sahyadri,
          status: CommunityOrderStatus.DELIVERED,
          totalAmount: 1000.0, // Mismatched total
          currency: 'INR',
          deliveryDeadline: new Date(Date.now() + 6 * 3600 * 1000),
          items: {
            create: [
              {
                productId: SEED_IDS.products.cookingOil,
                totalQuantity: 5.0,
                negotiatedUnitPrice: 200.0,
                totalPrice: 1000.0,
              },
            ],
          },
          residentOrders: {
            connect: [{ id: SEED_IDS.residentOrders.orderAarav }, { id: SEED_IDS.residentOrders.orderRiya }],
          },
          delivery: {
            create: {
              status: DeliveryStatus.DELIVERED,
              trackingCode: 'TRK-FIN-TEST',
              allocations: {
                create: [
                  {
                    residentOrderId: SEED_IDS.residentOrders.orderAarav,
                    productId: SEED_IDS.products.cookingOil,
                    quantity: 2.0,
                  },
                  {
                    residentOrderId: SEED_IDS.residentOrders.orderRiya,
                    productId: SEED_IDS.products.cookingOil,
                    quantity: 3.0,
                  },
                ],
              },
            },
          },
        },
      });

      const report = await reconciliationService.reconcileCommunityOrder(commOrder.id);

      expect(report.isReconciled).toBe(false);
      expect(report.financialReconciliation.passed).toBe(false);
      expect(report.discrepancies.some((d) => d.includes('Financial mismatch'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. DELIVERY FSM HARDENING & TERMINAL LOCK
  // ---------------------------------------------------------------------------
  describe('8. Delivery FSM Hardening', () => {
    const simulator = new DeliverySimulator();

    it('rejects backwards delivery transition (OUT_FOR_DELIVERY -> PREPARING)', async () => {
      const commOrder = await prisma.communityOrder.create({
        data: {
          societyId: SEED_IDS.society.greenview,
          supplierId: SEED_IDS.suppliers.sahyadri,
          status: CommunityOrderStatus.CREATED,
          totalAmount: 825.0,
          currency: 'INR',
          deliveryDeadline: new Date(Date.now() + 6 * 3600 * 1000),
        },
      });

      // Progress forward to OUT_FOR_DELIVERY
      await simulator.initializeDelivery(commOrder.id, DeliveryStatus.PREPARING);
      await simulator.advanceDelivery(commOrder.id, DeliveryStatus.DISPATCHED);
      await simulator.advanceDelivery(commOrder.id, DeliveryStatus.OUT_FOR_DELIVERY);

      // Attempt to regress backwards to PREPARING
      await expect(
        simulator.advanceDelivery(commOrder.id, DeliveryStatus.PREPARING)
      ).rejects.toMatchObject({
        code: 'INVALID_DELIVERY_TRANSITION',
      });
    });

    it('rejects skipping intermediate delivery states (PREPARING -> DELIVERED)', async () => {
      const commOrder = await prisma.communityOrder.create({
        data: {
          societyId: SEED_IDS.society.greenview,
          supplierId: SEED_IDS.suppliers.sahyadri,
          status: CommunityOrderStatus.CREATED,
          totalAmount: 825.0,
          currency: 'INR',
          deliveryDeadline: new Date(Date.now() + 6 * 3600 * 1000),
        },
      });

      await simulator.initializeDelivery(commOrder.id, DeliveryStatus.PREPARING);

      // Attempt to jump directly to DELIVERED
      await expect(
        simulator.advanceDelivery(commOrder.id, DeliveryStatus.DELIVERED)
      ).rejects.toMatchObject({
        code: 'INVALID_DELIVERY_TRANSITION',
      });
    });

    it('rejects transition away from terminal DELIVERED status (TERMINAL_STATE_LOCKED)', async () => {
      const commOrder = await prisma.communityOrder.create({
        data: {
          societyId: SEED_IDS.society.greenview,
          supplierId: SEED_IDS.suppliers.sahyadri,
          status: CommunityOrderStatus.CREATED,
          totalAmount: 825.0,
          currency: 'INR',
          deliveryDeadline: new Date(Date.now() + 6 * 3600 * 1000),
        },
      });

      // Progress all the way to DELIVERED
      await simulator.initializeDelivery(commOrder.id, DeliveryStatus.PREPARING);
      await simulator.advanceDelivery(commOrder.id, DeliveryStatus.DISPATCHED);
      await simulator.advanceDelivery(commOrder.id, DeliveryStatus.OUT_FOR_DELIVERY);
      await simulator.advanceDelivery(commOrder.id, DeliveryStatus.DELIVERED);

      // Attempt to regress away from DELIVERED
      await expect(
        simulator.advanceDelivery(commOrder.id, DeliveryStatus.DISPATCHED)
      ).rejects.toMatchObject({
        code: 'TERMINAL_STATE_LOCKED',
      });
    });

    it('duplicate terminal advance calls return isTerminal: true idempotently', async () => {
      const commOrder = await prisma.communityOrder.create({
        data: {
          societyId: SEED_IDS.society.greenview,
          supplierId: SEED_IDS.suppliers.sahyadri,
          status: CommunityOrderStatus.CREATED,
          totalAmount: 825.0,
          currency: 'INR',
          deliveryDeadline: new Date(Date.now() + 6 * 3600 * 1000),
        },
      });

      await simulator.initializeDelivery(commOrder.id, DeliveryStatus.PREPARING);
      await simulator.advanceDelivery(commOrder.id, DeliveryStatus.DISPATCHED);
      await simulator.advanceDelivery(commOrder.id, DeliveryStatus.OUT_FOR_DELIVERY);
      const delRes = await simulator.advanceDelivery(commOrder.id, DeliveryStatus.DELIVERED);

      expect(delRes.isTerminal).toBe(true);

      // Subsequent duplicate call
      const dupRes = await simulator.advanceDelivery(commOrder.id, DeliveryStatus.DELIVERED);
      expect(dupRes.isTerminal).toBe(true);
      expect(dupRes.currentStatus).toBe(DeliveryStatus.DELIVERED);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. API VALIDATION & ERROR MASKING
  // ---------------------------------------------------------------------------
  describe('9. API Validation & Error Masking', () => {
    it('returns structured HTTP 400 MALFORMED_JSON without internal leaks on corrupt JSON body', async () => {
      const res = await request(app)
        .post('/api/agent/run')
        .set('Content-Type', 'application/json')
        .send('{ "message": "unclosed json ');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MALFORMED_JSON');
      expect(res.body.error.stack).toBeUndefined();
    });

    it('never leaks stack traces in error responses', async () => {
      const { userService, sessionService } = await import('../src/identity');
      const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: `ep_mask_${suffix}`,
        email: `mask_${suffix}@relay.local`,
        name: 'Mask User',
      });
      const session = await sessionService.createSession(user.id);

      const res = await request(app)
        .post('/api/execution/payment')
        .set('Authorization', `Bearer ${session.token}`)
        .send({ residentOrderId: 'non-existent-uuid' });

      expect(res.status).toBe(404);
      expect(res.body.error.stack).toBeUndefined();
    });

    it('rejects invalid delivery status enum with HTTP 400 INVALID_STATUS', async () => {
      const { userService, sessionService } = await import('../src/identity');
      const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: `ep_enum_${suffix}`,
        email: `enum_${suffix}@relay.local`,
        name: 'Enum User',
      });
      const session = await sessionService.createSession(user.id);
      const society = await prisma.society.create({
        data: {
          name: `Enum Test Society ${suffix}`,
          address: '1 Test Road',
          city: 'Nashik',
          state: 'MH',
          postalCode: '422001',
        },
      });
      await prisma.resident.create({
        data: {
          id: user.residentId,
          societyId: society.id,
          name: 'Enum User',
          email: `enum_res_${suffix}@relay.local`,
        },
      });
      const deadline = new Date(Date.now() + 8 * 3600 * 1000);
      const { order: communityOrder } = await orderService.createCommunityOrder({
        societyId: society.id,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        idempotencyKey: `API-COMM-ENUM-${suffix}`,
        items: [
          {
            productId: SEED_IDS.products.cookingOil,
            totalQuantity: '5.0000',
            negotiatedUnitPrice: '165.00',
          },
        ],
      });

      const res = await request(app)
        .post('/api/execution/delivery/advance')
        .set('Authorization', `Bearer ${session.token}`)
        .send({
          communityOrderId: communityOrder.id,
          targetStatus: 'FLYING_CAR_STATUS',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_STATUS');
    });
  });

  // ---------------------------------------------------------------------------
  // 10. PRIVACY HARDENING
  // ---------------------------------------------------------------------------
  describe('10. Privacy Hardening', () => {
    it('resident orders are private to the resident and do not expose other residents data', async () => {
      const { userService, sessionService } = await import('../src/identity');
      const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      async function createResidentWithOrder(tag: string, tower: string) {
        const user = await userService.createUser({
          authProvider: 'EMAIL',
          providerAccountId: `ep_priv_${tag}_${suffix}`,
          email: `priv_${tag}_${suffix}@relay.local`,
          name: `Privacy User ${tag}`,
        });
        const session = await sessionService.createSession(user.id);
        const society = await prisma.society.create({
          data: {
            name: `Privacy Test Society ${tag} ${suffix}`,
            address: '1 Test Road',
            city: 'Nashik',
            state: 'MH',
            postalCode: '422001',
          },
        });
        await prisma.resident.create({
          data: {
            id: user.residentId,
            societyId: society.id,
            name: `Privacy User ${tag}`,
            email: `priv_res_${tag}_${suffix}@relay.local`,
            flatNumber: tower,
          },
        });
        await prisma.residentOrder.create({
          data: {
            residentId: user.residentId,
            societyId: society.id,
            status: ResidentOrderStatus.PENDING,
            totalAmount: '100.00',
            deliveryAddress: tower,
          },
        });
        return { token: session.token, residentId: user.residentId };
      }

      const a = await createResidentWithOrder('a', 'Tower A-101');
      const b = await createResidentWithOrder('b', 'Tower B-202');

      // Guests cannot read anyone's orders.
      const guest = await request(app).get('/api/portal/orders');
      expect(guest.status).toBe(401);

      // A reads only A's orders.
      const aOrders = await request(app)
        .get('/api/portal/orders')
        .set('Authorization', `Bearer ${a.token}`);
      expect(aOrders.status).toBe(200);
      expect(aOrders.body.data.length).toBeGreaterThan(0);
      for (const order of aOrders.body.data) {
        expect(order.deliveryAddress).toContain('Tower A-101');
        expect(order.deliveryAddress).not.toContain('Tower B-202');
      }

      // A cannot read B's orders via query override.
      const cross = await request(app)
        .get(`/api/portal/orders?residentId=${b.residentId}`)
        .set('Authorization', `Bearer ${a.token}`);
      expect(cross.status).toBe(403);
    });

    it('community demand aggregation exposes only aggregated pools, completely stripping resident PII', async () => {
      const aggRes = await request(app)
        .get(`/api/portal/community?societyId=${SEED_IDS.society.greenview}`);
      expect(aggRes.status).toBe(200);

      const pools = aggRes.body.data.activeDemandPools;
      expect(pools.length).toBeGreaterThan(0);

      for (const pool of pools) {
        expect(pool).toHaveProperty('productId');
        expect(pool).toHaveProperty('totalQuantity');
        expect(pool).toHaveProperty('unit');

        // Verify zero resident personal identifiable information
        expect((pool as any).residentName).toBeUndefined();
        expect((pool as any).flatNumber).toBeUndefined();
        expect((pool as any).email).toBeUndefined();
      }
    });

    it('audit trail records operational milestones only, never LLM reasoning or secrets', async () => {
      const audits = await prisma.auditEvent.findMany({
        take: 20,
        orderBy: { createdAt: 'desc' },
      });

      for (const audit of audits) {
        const metadataStr = JSON.stringify(audit.metadata || {});
        // Must never contain chain-of-thought or reasoning keys
        expect(metadataStr).not.toContain('thinking');
        expect(metadataStr).not.toContain('chainOfThought');
        expect(metadataStr).not.toContain('reasoning_content');
        expect(metadataStr).not.toContain('apiKey');
        expect(metadataStr).not.toContain('password');
      }
    });
  });
});
