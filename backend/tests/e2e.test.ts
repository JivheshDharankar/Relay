import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import {
  PrismaClient,
  ProductUnit,
  DeliveryStatus,
  CommunityOrderStatus,
  AuditEventType,
  PaymentStatus,
  ResidentOrderStatus,
} from '@prisma/client';
import { app } from '../src/app';
import { seed, SEED_IDS } from '../prisma/seed';
import { onboardFreshUser } from './helpers/onboardFreshUser';
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
import { executionService } from '../src/execution';

const prisma = new PrismaClient();

describe('Milestone 7 — End-to-End Autonomous Procurement Integration', () => {
  beforeAll(async () => {
    // Clean and seed the database with deterministic foundation
    await seed(prisma);
  });

  // ---------------------------------------------------------------------------
  // 1. CANONICAL HAPPY PATH DEMO SCENARIO
  // ---------------------------------------------------------------------------
  describe('1. Canonical Happy Path: Cooking Oil Scenario', () => {
    it('executes full 11-step autonomous procurement from natural language prompt to reconciliation', async () => {
      const demoPrompt =
        'I need 5 litres of sunflower cooking oil within 12 hours. Use community procurement if it can get me a better deal.';

      const u = await onboardFreshUser({
        emailPrefix: 'e2e.canonical',
        societyName: 'E2E Canonical Heights',
        mandateLimit: 10000,
      });

      const res = await request(app)
        .post('/api/agent/run')
        .set('Authorization', `Bearer ${u.token}`)
        .send({
          message: demoPrompt,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.completed).toBe(true);
      expect(res.body.response).toContain('Relay autonomous procurement is complete');

      // 1. Verify all 11 tools executed in exact sequential order
      const executedTools = res.body.steps
        .filter((s: any) => s.toolCall)
        .map((s: any) => s.toolCall.name);

      expect(executedTools).toEqual([
        'createRequest',
        'checkAuthorization',
        'aggregateDemand',
        'discoverSuppliers',
        'evaluateOffers',
        'selectOffer',
        'createCommunityOrder',
        'allocateResidentOrders',
        'requestPayment',
        'trackDelivery',
        'reconcileOrder',
      ]);

      // 2. Extract step outputs
      const stepMap = new Map<string, any>();
      for (const s of res.body.steps) {
        if (s.toolCall) {
          stepMap.set(s.toolCall.name, s.toolCall.result);
        }
      }

      const reqRes = stepMap.get('createRequest');
      expect(reqRes.success).toBe(true);
      expect(reqRes.quantity).toBe(5);
      expect(reqRes.unit).toBe('LITRE');
      const residentOrderId = reqRes.orderId;

      const authRes = stepMap.get('checkAuthorization');
      expect(authRes.authorized).toBe(true);
      expect(authRes.requestedAmount).toBe(825);

      const commOrderRes = stepMap.get('createCommunityOrder');
      expect(commOrderRes.success).toBe(true);
      const communityOrderId = commOrderRes.order.id;

      const payRes = stepMap.get('requestPayment');
      expect(payRes.success).toBe(true);
      expect(payRes.status).toBe(PaymentStatus.SUCCESS);
      expect(payRes.providerReference).toMatch(/^MOCK-TXN-/);

      const delivRes = stepMap.get('trackDelivery');
      expect(delivRes.success).toBe(true);
      expect(delivRes.status).toBe(DeliveryStatus.DELIVERED);
      expect(delivRes.trackingCode).toMatch(/^TRK-SIM-/);

      const reconRes = stepMap.get('reconcileOrder');
      expect(reconRes.isReconciled).toBe(true);
      expect(reconRes.status).toBe('RECONCILED');
      expect(reconRes.quantityPassed).toBe(true);
      expect(reconRes.financialPassed).toBe(true);
      expect(reconRes.productPassed).toBe(true);
      expect(reconRes.societyPassed).toBe(true);
      expect(reconRes.discrepancies).toHaveLength(0);

      // 3. Verify PostgreSQL Persistence
      const dbResidentOrder = await prisma.residentOrder.findUnique({
        where: { id: residentOrderId },
        include: { payments: true, items: true },
      });
      expect(dbResidentOrder).not.toBeNull();
      expect(dbResidentOrder!.status).toBe(ResidentOrderStatus.PAID);
      expect(dbResidentOrder!.payments.length).toBeGreaterThan(0);
      expect(dbResidentOrder!.payments[0].status).toBe(PaymentStatus.SUCCESS);
      expect(dbResidentOrder!.payments[0].providerReference).toBe(payRes.providerReference);

      const dbCommunityOrder = await prisma.communityOrder.findUnique({
        where: { id: communityOrderId },
        include: { delivery: { include: { allocations: true } }, items: true },
      });
      expect(dbCommunityOrder).not.toBeNull();
      expect(dbCommunityOrder!.status).toBe(CommunityOrderStatus.RECONCILED);
      expect(dbCommunityOrder!.delivery).not.toBeNull();
      expect(dbCommunityOrder!.delivery!.status).toBe(DeliveryStatus.DELIVERED);
      expect(dbCommunityOrder!.delivery!.trackingCode).toBe(delivRes.trackingCode);
      expect(dbCommunityOrder!.delivery!.allocations.length).toBeGreaterThanOrEqual(1);

      // 4. Verify Operational Audit Trail
      const auditEvents = await prisma.auditEvent.findMany({
        where: {
          OR: [
            { entityId: residentOrderId },
            { entityId: communityOrderId },
            { metadata: { path: ['communityOrderId'], equals: communityOrderId } },
          ],
        },
      });
      expect(auditEvents.length).toBeGreaterThan(0);
      const eventTypes = auditEvents.map((e) => e.eventType);
      expect(eventTypes).toContain(AuditEventType.RECONCILED);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. AUTHORIZATION BOUNDARY INVARIANTS
  // ---------------------------------------------------------------------------
  describe('2. Authorization Boundary Invariants', () => {
    it('authorizes requests strictly within the mandate limit (₹825 <= ₹10,000)', async () => {
      const auth = await authorizationService.checkAuthorization({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        requestedAmount: 825.0,
      });

      expect(auth.authorized).toBe(true);
      expect(auth.code).toBe('AUTHORIZED');
      expect(auth.maxAuthorizedAmount).toBeDefined();
    });

    it('authorizes boundary requests exactly equal to the maximum mandate limit (₹8,000 == ₹8,000)', async () => {
      const auth = await authorizationService.checkAuthorization({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        requestedAmount: 8000.0,
      });

      expect(auth.authorized).toBe(true);
      expect(auth.code).toBe('AUTHORIZED');
    });

    it('deterministically rejects requests that exceed the authorized spending cap (₹8,001 > ₹8,000)', async () => {
      const auth = await authorizationService.checkAuthorization({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        requestedAmount: 8001.0,
      });

      expect(auth.authorized).toBe(false);
      expect(auth.code).toBe('REJECTED');
      expect(auth.reason).toContain('MANDATE_LIMIT_EXCEEDED');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. DEMAND AGGREGATION & PRIVACY BOUNDARY
  // ---------------------------------------------------------------------------
  describe('3. Demand Aggregation & Privacy Boundary', () => {
    it('aggregates individual compatible resident demands into anonymous bulk groups', async () => {
      const { internalGroups, supplierFacingGroups } =
        await aggregationService.aggregateSocietyDemand(SEED_IDS.society.greenview);

      // Verify Rice aggregation: 5kg + 10kg + 8kg = 23kg
      const riceGroup = supplierFacingGroups.find((g) => g.productId === SEED_IDS.products.rice);
      expect(riceGroup).toBeDefined();
      expect(Number(riceGroup!.totalQuantity)).toBe(23.0);
      expect(riceGroup!.unit).toBe(ProductUnit.KG);

      // Verify Cooking Oil aggregation: 2L + 3L = 5L
      const oilGroup = supplierFacingGroups.find((g) => g.productId === SEED_IDS.products.cookingOil);
      expect(oilGroup).toBeDefined();
      expect(Number(oilGroup!.totalQuantity)).toBe(5.0);
      expect(oilGroup!.unit).toBe(ProductUnit.LITRE);

      // Invariant: SUM(individual compatible demand) == community procurement quantity
      const riceInternal = internalGroups.find((g) => g.productId === SEED_IDS.products.rice);
      expect(riceInternal).toBeDefined();
      const internalSum = riceInternal!.residentDemands.reduce(
        (sum, o) => sum + Number(o.quantity),
        0
      );
      expect(internalSum).toBe(Number(riceGroup!.totalQuantity));

      // Privacy Invariant: Supplier facing group contains ZERO resident PII
      for (const group of supplierFacingGroups) {
        expect((group as any).residentNames).toBeUndefined();
        expect((group as any).flatNumbers).toBeUndefined();
        expect((group as any).residentIds).toBeUndefined();
        expect((group as any).emails).toBeUndefined();
        expect(group.contributingOrdersCount).toBeGreaterThan(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 4. SUPPLIER SELECTION & HARD CONSTRAINTS
  // ---------------------------------------------------------------------------
  describe('4. Supplier Hard Constraints & Deterministic Selection', () => {
    it('filters out suppliers that violate the 12-hour SLA constraint', async () => {
      const results = await supplierService.filterEligibleSuppliers({
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.cookingOil,
        requestedQuantity: 5.0,
        maxSlaHours: 12.0,
      });

      for (const res of results) {
        if (res.estimatedDeliveryHours > 12.0) {
          expect(res.eligible).toBe(false);
          expect(res.reasons.some((r) => r.includes('SLA'))).toBe(true);
        }
      }
    });

    it('selects the optimal compliant offer using multi-factor scoring (price 50%, reliability 30%, speed 20%)', async () => {
      const winning = await offerService.selectBestOffer({
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.cookingOil,
        totalQuantity: 5.0,
      });

      expect(winning.supplierId).toBe(SEED_IDS.suppliers.sahyadri);
      expect(winning.supplierName).toBe('Sahyadri Agro Wholesalers');
      expect(Number(winning.totalPrice)).toBe(825.0); // 5L * 165.00
      expect(winning.deliveryHours).toBeLessThanOrEqual(12);
      expect(winning.compositeScore).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. RESIDENT ALLOCATION & THREE-WAY RECONCILIATION
  // ---------------------------------------------------------------------------
  describe('5. Resident Allocation & Deterministic 3-Way Reconciliation', () => {
    it('verifies that resident allocations balance community order quantity and amount exactly', async () => {
      // 1. Create a fresh CommunityOrder
      const commOrderResult = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: new Date(Date.now() + 8 * 3600 * 1000),
        idempotencyKey: `IDEMP-COMM-RECON-${Date.now()}`,
        items: [
          {
            productId: SEED_IDS.products.cookingOil,
            totalQuantity: '5.0000',
            negotiatedUnitPrice: '165.00',
          },
        ],
      });
      const commOrderId = commOrderResult.order.id;

      // 2. Create ResidentOrder
      const reqVal = await requestService.validateRequest({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.cookingOil,
        quantity: 5.0,
        unit: ProductUnit.LITRE,
        deliveryAddress: 'Tower A-101',
      });
      const resOrder = await requestService.createResidentOrder(reqVal);

      // Link residentOrder to communityOrder
      await prisma.residentOrder.update({
        where: { id: resOrder.id },
        data: { communityOrderId: commOrderId },
      });

      // 3. Allocate Community Delivery
      const delivery = await allocationService.allocateCommunityDelivery({
        communityOrderId: commOrderId,
        allocations: [
          {
            residentOrderId: resOrder.id,
            productId: SEED_IDS.products.cookingOil,
            quantity: '5.0000',
          },
        ],
      });

      expect(delivery).not.toBeNull();
      expect(delivery!.allocations.length).toBe(1);
      expect(Number(delivery!.allocations[0].quantity)).toBe(5.0);

      // 4. Progress delivery to DELIVERED
      await executionService.advanceCommunityDelivery(commOrderId, DeliveryStatus.PREPARING);
      await executionService.advanceCommunityDelivery(commOrderId, DeliveryStatus.DISPATCHED);
      await executionService.advanceCommunityDelivery(commOrderId, DeliveryStatus.OUT_FOR_DELIVERY);
      await executionService.advanceCommunityDelivery(commOrderId, DeliveryStatus.DELIVERED);

      // 5. Run Reconciliation
      const report = await reconciliationService.reconcileCommunityOrder(commOrderId);

      expect(report.isReconciled).toBe(true);
      expect(report.status).toBe('RECONCILED');
      expect(report.quantityReconciliation.passed).toBe(true);
      expect(report.financialReconciliation.passed).toBe(true);
      expect(report.productIntegrity.passed).toBe(true);
      expect(report.societyIntegrity.passed).toBe(true);
      expect(report.discrepancies).toHaveLength(0);

      // Verify CommunityOrder transitioned to RECONCILED in database
      const finalOrder = await prisma.communityOrder.findUnique({
        where: { id: commOrderId },
      });
      expect(finalOrder!.status).toBe(CommunityOrderStatus.RECONCILED);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. PAYMENT IDEMPOTENCY & EXECUTION
  // ---------------------------------------------------------------------------
  describe('6. Payment Idempotency & Safety', () => {
    it('executing payment twice for the same resident order returns existing payment without double charging', async () => {
      const validated = await requestService.validateRequest({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.cookingOil,
        quantity: 2.0,
        unit: ProductUnit.LITRE,
        deliveryAddress: 'Tower A-101',
      });
      const order = await requestService.createResidentOrder(validated);

      // First execution
      const pay1 = await executionService.executeResidentPayment({
        residentOrderId: order.id,
        amount: 330.0,
        idempotencyKey: `IDEMP-DOUBLE-PAY-${order.id}`,
      });
      expect(pay1.success).toBe(true);
      expect(pay1.payment.status).toBe(PaymentStatus.SUCCESS);

      // Second execution with identical idempotency context
      const pay2 = await executionService.executeResidentPayment({
        residentOrderId: order.id,
        amount: 330.0,
        idempotencyKey: `IDEMP-DOUBLE-PAY-${order.id}`,
      });

      expect(pay2.success).toBe(true);
      expect(pay2.payment.providerReference).toBe(pay1.payment.providerReference);

      // Confirm only 1 successful payment record exists in PostgreSQL
      const paymentCount = await prisma.payment.count({
        where: { residentOrderId: order.id, status: PaymentStatus.SUCCESS },
      });
      expect(paymentCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. DELIVERY FSM PROGRESSION & TERMINAL LOCK
  // ---------------------------------------------------------------------------
  describe('7. Delivery FSM Progression & Terminal State Lock', () => {
    it('rejects illegal status jumps and backward transitions', async () => {
      const commOrder = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: new Date(Date.now() + 8 * 3600 * 1000),
        idempotencyKey: `IDEMP-DELIV-FSM-${Date.now()}`,
        items: [
          {
            productId: SEED_IDS.products.cookingOil,
            totalQuantity: '5.0000',
            negotiatedUnitPrice: '165.00',
          },
        ],
      });

      // Initialize at PREPARING
      await executionService.advanceCommunityDelivery(commOrder.order.id, DeliveryStatus.PREPARING);

      // Illegal backward transition to PENDING must fail
      await expect(
        executionService.advanceCommunityDelivery(commOrder.order.id, DeliveryStatus.PENDING)
      ).rejects.toThrow();

      // Step through to terminal DELIVERED
      await executionService.advanceCommunityDelivery(commOrder.order.id, DeliveryStatus.DISPATCHED);
      await executionService.advanceCommunityDelivery(commOrder.order.id, DeliveryStatus.OUT_FOR_DELIVERY);
      const delivered = await executionService.advanceCommunityDelivery(
        commOrder.order.id,
        DeliveryStatus.DELIVERED
      );
      expect(delivered.currentStatus).toBe(DeliveryStatus.DELIVERED);
      expect(delivered.isTerminal).toBe(true);

      // Attempting to transition away from terminal DELIVERED must throw error
      await expect(
        executionService.advanceCommunityDelivery(commOrder.order.id, DeliveryStatus.DISPATCHED)
      ).rejects.toThrow(/terminal delivery state/i);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. PERSISTENCE & PORTAL API VERIFICATION
  // ---------------------------------------------------------------------------
  describe('8. Portal API & PostgreSQL Persistence Verification', () => {
    async function createPortalResident(tag: string) {
      const { userService, sessionService } = await import('../src/identity');
      const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: `ep_portal_${tag}_${suffix}`,
        email: `portal_${tag}_${suffix}@relay.local`,
        name: `Portal User ${tag}`,
      });
      const session = await sessionService.createSession(user.id);
      const society = await prisma.society.create({
        data: {
          name: `Portal Test Society ${tag} ${suffix}`,
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
          name: `Portal User ${tag}`,
          email: `portal_res_${tag}_${suffix}@relay.local`,
          flatNumber: 'T-1',
        },
      });
      return { user, token: session.token, residentId: user.residentId, societyId: society.id };
    }

    it('GET /api/portal/orders returns the session resident orders persisted in PostgreSQL', async () => {
      const { token, residentId, societyId } = await createPortalResident('orders');
      const order = await prisma.residentOrder.create({
        data: {
          residentId,
          societyId,
          status: ResidentOrderStatus.PENDING,
          totalAmount: '330.00',
          deliveryAddress: 'Tower P-101',
          items: {
            create: [
              {
                productId: SEED_IDS.products.cookingOil,
                quantity: '2.0000',
                unitPrice: '165.00',
                totalPrice: '330.00',
              },
            ],
          },
        },
      });

      const res = await request(app)
        .get('/api/portal/orders')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);

      // Verify item details
      const mine = res.body.data.find((o: any) => o.id === order.id);
      expect(mine).toBeDefined();
      expect(mine.totalAmount).toBeGreaterThan(0);
      expect(mine.items.length).toBeGreaterThan(0);
    });

    it('GET /api/portal/payments returns the session resident mandate and transaction history from DB', async () => {
      const { token, residentId } = await createPortalResident('payments');
      const mandate = await prisma.paymentMandate.create({
        data: {
          residentId,
          status: 'ACTIVE',
          maximumAmount: '8000',
          purpose: 'COMMUNITY_PROCUREMENT',
          periodStart: new Date(),
        },
      });
      const order = await prisma.residentOrder.create({
        data: {
          residentId,
          societyId: SEED_IDS.society.greenview,
          status: ResidentOrderStatus.PENDING,
          totalAmount: '500.00',
          deliveryAddress: 'Tower P-102',
        },
      });
      await prisma.payment.create({
        data: {
          residentOrderId: order.id,
          paymentMandateId: mandate.id,
          amount: '500.00',
          status: PaymentStatus.SUCCESS,
        },
      });

      const res = await request(app)
        .get('/api/portal/payments')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.mandate).toBeDefined();
      expect(res.body.data.mandate.maximumAmount).toBe(8000);
      expect(Array.isArray(res.body.data.transactions)).toBe(true);
      expect(res.body.data.transactions.length).toBeGreaterThan(0);
    });

    it('GET /api/portal/orders and /payments reject unauthenticated guests with 401', async () => {
      const orders = await request(app).get('/api/portal/orders');
      expect(orders.status).toBe(401);
      const payments = await request(app).get('/api/portal/payments');
      expect(payments.status).toBe(401);
      const resident = await request(app).get('/api/portal/resident');
      expect(resident.status).toBe(401);
    });

    it('GET /api/portal/community returns aggregated pools with zero resident PII', async () => {
      const res = await request(app).get('/api/portal/community');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.activeDemandPools).toBeDefined();
      expect(res.body.data.totalFlatsRepresentation).toBe(550);

      for (const pool of res.body.data.activeDemandPools) {
        expect(pool.productName).toBeDefined();
        expect(pool.totalQuantity).toBeGreaterThan(0);
        expect((pool as any).residentNames).toBeUndefined();
      }
    });
  });
});
