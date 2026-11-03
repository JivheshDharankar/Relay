import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { PrismaClient, ProductUnit, DeliveryStatus, CommunityOrderStatus, AuditEventType, PaymentStatus } from '@prisma/client';
import { app } from '../src/app';
import { seed, SEED_IDS } from '../prisma/seed';
import {
  executionService,
  ExecutionService,
  ExecutionError,
} from '../src/execution';
import { MockPaymentProvider } from '../src/execution/payment/MockPaymentProvider';
import { MockSupplierProvider } from '../src/execution/supplier/MockSupplierProvider';
import { DeliverySimulator, DeliverySimulatorError } from '../src/execution/delivery/DeliverySimulator';
import { orderService, requestService } from '../src/services/procurement';

const prisma = new PrismaClient();

describe('Milestone 5 — Relay Execution Layer', () => {
  beforeAll(async () => {
    // Ensure clean deterministic seeded state
    await seed(prisma);
  });

  // -------------------------------------------------------------------------
  // 1. PAYMENT ADAPTER & PRE-AUTHORIZED PAYMENT EXECUTION
  // -------------------------------------------------------------------------
  describe('1. Payment Adapter & Execution', () => {
    it('executes pre-authorized resident payment successfully within mandate cap', async () => {
      // Create a fresh resident order for Aarav (mandate limit = ₹10,000)
      const validated = await requestService.validateRequest({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.cookingOil,
        quantity: 5.0,
        unit: ProductUnit.LITRE,
        deliveryAddress: 'Tower A-101',
      });
      const order = await requestService.createResidentOrder(validated);

      const result = await executionService.executeResidentPayment({
        residentOrderId: order.id,
        amount: 825.0,
        idempotencyKey: `IDEMP-PAY-TEST-${order.id}`,
      });

      expect(result.success).toBe(true);
      expect(result.orderId).toBe(order.id);
      expect(result.residentOrderStatus).toBe('PAID');
      expect(result.payment.status).toBe(PaymentStatus.SUCCESS);
      expect(result.payment.providerReference).toMatch(/^MOCK-TXN-/);
      expect(result.payment.amount).toBe(825.0);

      // Verify database record
      const dbPayment = await prisma.payment.findFirst({
        where: { residentOrderId: order.id },
      });
      expect(dbPayment).toBeDefined();
      expect(dbPayment?.status).toBe(PaymentStatus.SUCCESS);
      expect(Number(dbPayment?.amount)).toBe(825.0);

      // Verify audit events recorded
      const auditEvents = await prisma.auditEvent.findMany({
        where: { entityId: order.id },
      });
      const eventTypes = auditEvents.map((e) => e.eventType);
      expect(eventTypes).toContain(AuditEventType.PAYMENT_EXECUTION_STARTED);
      expect(eventTypes).toContain(AuditEventType.PAYMENT_EXECUTION_SUCCEEDED);
    });

    it('refuses payment when the declared payer does not own the order (FORBIDDEN)', async () => {
      const validated = await requestService.validateRequest({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.cookingOil,
        quantity: 1.0,
        unit: ProductUnit.LITRE,
        deliveryAddress: 'Tower A-101',
      });
      const order = await requestService.createResidentOrder(validated);

      await expect(
        executionService.executeResidentPayment({
          residentOrderId: order.id,
          expectedResidentId: 'res_someone_else',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects payment and throws MANDATE_LIMIT_EXCEEDED when requested amount exceeds mandate', async () => {
      // Create resident order for Ananya (mandate limit = ₹4,000)
      const validated = await requestService.validateRequest({
        residentId: SEED_IDS.residents.ananya,
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.cookingOil,
        quantity: 5.0,
        unit: ProductUnit.LITRE,
        deliveryAddress: 'Tower D-401',
      });
      const order = await requestService.createResidentOrder(validated);

      // Attempt to charge ₹15,000 (> ₹4,000 limit)
      await expect(
        executionService.executeResidentPayment({
          residentOrderId: order.id,
          amount: 15000.0,
          idempotencyKey: `IDEMP-FAIL-PAY-${order.id}`,
        })
      ).rejects.toMatchObject({
        code: 'MANDATE_LIMIT_EXCEEDED',
      });

      // Verify failed audit event recorded
      const failedAudit = await prisma.auditEvent.findFirst({
        where: {
          entityId: order.id,
          eventType: AuditEventType.PAYMENT_EXECUTION_FAILED,
        },
      });
      expect(failedAudit).toBeDefined();

      // Ensure order status was not changed to PAID
      const dbOrder = await prisma.residentOrder.findUnique({
        where: { id: order.id },
      });
      expect(dbOrder?.status).not.toBe('PAID');
    });

    it('handles simulated payment provider decline/failure cleanly', async () => {
      const customPaymentMock = new MockPaymentProvider({
        mode: 'failure',
        failureCode: 'INSUFFICIENT_FUNDS',
        failureReason: 'Account balance insufficient.',
      });
      const customExecService = new ExecutionService({ paymentAdapter: customPaymentMock });

      const validated = await requestService.validateRequest({
        residentId: SEED_IDS.residents.kabir,
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.rice,
        quantity: 5.0,
        unit: ProductUnit.KG,
        deliveryAddress: 'Tower B-201',
      });
      const order = await requestService.createResidentOrder(validated);

      await expect(
        customExecService.executeResidentPayment({
          residentOrderId: order.id,
          idempotencyKey: `IDEMP-SIM-FAIL-${order.id}`,
        })
      ).rejects.toMatchObject({
        code: 'INSUFFICIENT_FUNDS',
      });

      // Verify failed payment record persisted in DB
      const dbPayment = await prisma.payment.findFirst({
        where: { residentOrderId: order.id, status: PaymentStatus.FAILED },
      });
      expect(dbPayment).toBeDefined();
      expect(dbPayment?.failureCode).toBe('INSUFFICIENT_FUNDS');
    });

    it('enforces idempotency on duplicate payment execution requests', async () => {
      const validated = await requestService.validateRequest({
        residentId: SEED_IDS.residents.riya,
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.cookingOil,
        quantity: 3.0,
        unit: ProductUnit.LITRE,
        deliveryAddress: 'Tower B-102',
      });
      const order = await requestService.createResidentOrder(validated);
      const idempotencyKey = `IDEMP-DUP-PAY-${order.id}`;

      // First call
      const firstResult = await executionService.executeResidentPayment({
        residentOrderId: order.id,
        idempotencyKey,
      });
      expect(firstResult.success).toBe(true);
      expect(firstResult.payment.isDuplicate).toBe(false);

      // Second duplicate call
      const secondResult = await executionService.executeResidentPayment({
        residentOrderId: order.id,
        idempotencyKey,
      });
      expect(secondResult.success).toBe(true);
      expect(secondResult.payment.isDuplicate).toBe(true);
      expect(secondResult.payment.providerReference).toBe(firstResult.payment.providerReference);

      // Verify only 1 payment row exists in DB
      const paymentsCount = await prisma.payment.count({
        where: { residentOrderId: order.id },
      });
      expect(paymentsCount).toBe(1);
    });

    it('rejects payment with PAYMENT_GATEWAY_UNAVAILABLE when provider simulates downtime', async () => {
      const downtimeMock = new MockPaymentProvider({ simulateUnavailable: true });
      const downtimeExecService = new ExecutionService({ paymentAdapter: downtimeMock });

      const validated = await requestService.validateRequest({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.wheat,
        quantity: 5.0,
        unit: ProductUnit.KG,
        deliveryAddress: 'Tower A-101',
      });
      const order = await requestService.createResidentOrder(validated);

      await expect(
        downtimeExecService.executeResidentPayment({
          residentOrderId: order.id,
          idempotencyKey: `IDEMP-DOWNTIME-${order.id}`,
        })
      ).rejects.toMatchObject({
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
      });
    });
  });

  // -------------------------------------------------------------------------
  // 2. SUPPLIER ADAPTER & ANONYMIZED PURCHASE ORDER SUBMISSION
  // -------------------------------------------------------------------------
  describe('2. Supplier Adapter & Anonymized Bulk Procurement', () => {
    it('submits strictly anonymized bulk PO and confirms order with supplier', async () => {
      const deadline = new Date(Date.now() + 8 * 3600 * 1000);
      const { order: communityOrder } = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        idempotencyKey: `IDEMP-COMM-SUPPLIER-TEST-${Date.now()}`,
        items: [
          {
            productId: SEED_IDS.products.cookingOil,
            totalQuantity: '5.0000',
            negotiatedUnitPrice: '165.00',
          },
        ],
        contributingResidentOrderIds: [SEED_IDS.residentOrders.orderAarav],
      });

      const result = await executionService.executeSupplierProcurement({
        communityOrderId: communityOrder.id,
        idempotencyKey: `IDEMP-PO-SUBMIT-${communityOrder.id}`,
      });

      expect(result.success).toBe(true);
      expect(result.communityOrderId).toBe(communityOrder.id);
      expect(result.status).toBe(CommunityOrderStatus.SUPPLIER_CONFIRMED);
      expect(result.po.poReference).toMatch(/^MOCK-PO-/);
      expect(['CONFIRMED', 'PREPARING']).toContain(result.po.status);
      expect(result.po.confirmedDeliveryEta).toBeDefined();

      // Verify CommunityOrder state updated in database
      const dbOrder = await prisma.communityOrder.findUnique({
        where: { id: communityOrder.id },
      });
      expect(dbOrder?.status).toBe(CommunityOrderStatus.SUPPLIER_CONFIRMED);

      // Verify audit events recorded
      const poAuditEvents = await prisma.auditEvent.findMany({
        where: { entityId: communityOrder.id },
      });
      const types = poAuditEvents.map((e) => e.eventType);
      expect(types).toContain(AuditEventType.SUPPLIER_PO_SUBMITTED);
      expect(types).toContain(AuditEventType.SUPPLIER_CONFIRMED);
    });

    it('handles simulated supplier capacity rejection cleanly', async () => {
      const rejectSupplierMock = new MockSupplierProvider({
        mode: 'reject',
        rejectionCode: 'SUPPLIER_CAPACITY_EXCEEDED',
        rejectionReason: 'Supplier inventory full.',
      });
      const rejectExecService = new ExecutionService({ supplierAdapter: rejectSupplierMock });

      const deadline = new Date(Date.now() + 8 * 3600 * 1000);
      const { order: communityOrder } = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        idempotencyKey: `IDEMP-COMM-REJECT-TEST-${Date.now()}`,
        items: [
          {
            productId: SEED_IDS.products.rice,
            totalQuantity: '20.0000',
            negotiatedUnitPrice: '85.00',
          },
        ],
      });

      await expect(
        rejectExecService.executeSupplierProcurement({
          communityOrderId: communityOrder.id,
          idempotencyKey: `IDEMP-PO-REJECT-${communityOrder.id}`,
        })
      ).rejects.toMatchObject({
        code: 'SUPPLIER_CAPACITY_EXCEEDED',
      });

      // Verify rejection audit event
      const rejectAudit = await prisma.auditEvent.findFirst({
        where: {
          entityId: communityOrder.id,
          eventType: AuditEventType.SUPPLIER_REJECTED,
        },
      });
      expect(rejectAudit).toBeDefined();
    });

    it('enforces idempotency on duplicate supplier PO submissions', async () => {
      const deadline = new Date(Date.now() + 8 * 3600 * 1000);
      const { order: communityOrder } = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        idempotencyKey: `IDEMP-COMM-DUP-PO-${Date.now()}`,
        items: [
          {
            productId: SEED_IDS.products.cookingOil,
            totalQuantity: '5.0000',
            negotiatedUnitPrice: '165.00',
          },
        ],
      });

      const key = `IDEMP-PO-KEY-${communityOrder.id}`;
      const first = await executionService.executeSupplierProcurement({
        communityOrderId: communityOrder.id,
        idempotencyKey: key,
      });
      expect(first.success).toBe(true);
      expect(first.po.isDuplicate).toBe(false);

      const second = await executionService.executeSupplierProcurement({
        communityOrderId: communityOrder.id,
        idempotencyKey: key,
      });
      expect(second.success).toBe(true);
      expect(second.po.isDuplicate).toBe(true);
      expect(second.po.poReference).toBe(first.po.poReference);
    });
  });

  // -------------------------------------------------------------------------
  // 3. DETERMINISTIC DELIVERY SIMULATOR
  // -------------------------------------------------------------------------
  describe('3. Deterministic Delivery Simulator', () => {
    it('initializes and advances delivery sequentially through legal state progression', async () => {
      const deadline = new Date(Date.now() + 8 * 3600 * 1000);
      const { order: communityOrder } = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        idempotencyKey: `IDEMP-COMM-DELIV-TEST-${Date.now()}`,
        items: [
          {
            productId: SEED_IDS.products.cookingOil,
            totalQuantity: '5.0000',
            negotiatedUnitPrice: '165.00',
          },
        ],
      });

      const simulator = new DeliverySimulator();

      // 1. Initialize
      const initSnap = await simulator.initializeDelivery(communityOrder.id, DeliveryStatus.PREPARING);
      expect(initSnap.status).toBe(DeliveryStatus.PREPARING);
      expect(initSnap.trackingCode).toMatch(/^TRK-SIM-/);

      // 2. Advance to DISPATCHED
      const t1 = await simulator.advanceDelivery(communityOrder.id, DeliveryStatus.DISPATCHED);
      expect(t1.fromStatus).toBe(DeliveryStatus.PREPARING);
      expect(t1.toStatus).toBe(DeliveryStatus.DISPATCHED);

      // 3. Advance to OUT_FOR_DELIVERY
      const t2 = await simulator.advanceDelivery(communityOrder.id, DeliveryStatus.OUT_FOR_DELIVERY);
      expect(t2.fromStatus).toBe(DeliveryStatus.DISPATCHED);
      expect(t2.toStatus).toBe(DeliveryStatus.OUT_FOR_DELIVERY);

      // 4. Advance to DELIVERED
      const t3 = await simulator.advanceDelivery(communityOrder.id, DeliveryStatus.DELIVERED);
      expect(t3.fromStatus).toBe(DeliveryStatus.OUT_FOR_DELIVERY);
      expect(t3.toStatus).toBe(DeliveryStatus.DELIVERED);

      // 5. Final status check
      const finalSnap = await simulator.getDeliveryStatus(communityOrder.id);
      expect(finalSnap.status).toBe(DeliveryStatus.DELIVERED);
      expect(finalSnap.deliveredAt).toBeDefined();
    });

    it('rejects illegal state jumps (e.g. PREPARING -> DELIVERED skipping stages)', async () => {
      const deadline = new Date(Date.now() + 8 * 3600 * 1000);
      const { order: communityOrder } = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        idempotencyKey: `IDEMP-COMM-DELIV-JUMP-${Date.now()}`,
        items: [
          {
            productId: SEED_IDS.products.cookingOil,
            totalQuantity: '5.0000',
            negotiatedUnitPrice: '165.00',
          },
        ],
      });

      const simulator = new DeliverySimulator();
      await simulator.initializeDelivery(communityOrder.id, DeliveryStatus.PREPARING);

      // Illegal skip from PREPARING to DELIVERED directly
      await expect(
        simulator.advanceDelivery(communityOrder.id, DeliveryStatus.DELIVERED)
      ).rejects.toMatchObject({
        code: 'INVALID_DELIVERY_TRANSITION',
      });
    });

    it('locks terminal state and rejects transitions once DELIVERED', async () => {
      const deadline = new Date(Date.now() + 8 * 3600 * 1000);
      const { order: communityOrder } = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        idempotencyKey: `IDEMP-COMM-DELIV-TERM-${Date.now()}`,
        items: [
          {
            productId: SEED_IDS.products.cookingOil,
            totalQuantity: '5.0000',
            negotiatedUnitPrice: '165.00',
          },
        ],
      });

      const simulator = new DeliverySimulator();
      await simulator.initializeDelivery(communityOrder.id, DeliveryStatus.PREPARING);
      await simulator.advanceDelivery(communityOrder.id, DeliveryStatus.DISPATCHED);
      await simulator.advanceDelivery(communityOrder.id, DeliveryStatus.OUT_FOR_DELIVERY);
      await simulator.advanceDelivery(communityOrder.id, DeliveryStatus.DELIVERED);

      // Attempt to revert back to PREPARING
      await expect(
        simulator.advanceDelivery(communityOrder.id, DeliveryStatus.PREPARING)
      ).rejects.toMatchObject({
        code: 'TERMINAL_STATE_LOCKED',
      });
    });
  });

  // -------------------------------------------------------------------------
  // 4. FULL EXECUTION CYCLE: REQUEST -> PAYMENT -> PO -> DELIVERY -> RECONCILE
  // -------------------------------------------------------------------------
  describe('4. Full End-to-End Procurement Execution Pipeline', () => {
    it('executes the complete cycle with multi-factor reconciliation', async () => {
      // 1. Create resident order
      const validated = await requestService.validateRequest({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.cookingOil,
        quantity: 5.0,
        unit: ProductUnit.LITRE,
        deliveryAddress: 'Tower A-101',
      });
      const residentOrder = await requestService.createResidentOrder(validated);

      // 2. Create community order
      const deadline = new Date(Date.now() + 8 * 3600 * 1000);
      const { order: communityOrder } = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        idempotencyKey: `IDEMP-COMM-FULL-CYCLE-${Date.now()}`,
        items: [
          {
            productId: SEED_IDS.products.cookingOil,
            totalQuantity: '5.0000',
            negotiatedUnitPrice: '165.00',
          },
        ],
        contributingResidentOrderIds: [residentOrder.id],
      });

      // 3. Execute full cycle
      const cycleResult = await executionService.executeFullProcurementCycle({
        communityOrderId: communityOrder.id,
        allocations: [
          {
            residentOrderId: residentOrder.id,
            productId: SEED_IDS.products.cookingOil,
            quantity: '5.0000',
          },
        ],
      });

      expect(cycleResult.success).toBe(true);
      expect(cycleResult.communityOrderId).toBe(communityOrder.id);
      expect(cycleResult.payments.length).toBe(1);
      expect(cycleResult.payments[0].success).toBe(true);
      expect(cycleResult.payments[0].residentOrderStatus).toBe('PAID');
      expect(['CONFIRMED', 'PREPARING']).toContain(cycleResult.supplierPO.status);
      expect(cycleResult.delivery.status).toBe(DeliveryStatus.DELIVERED);

      // 4. Verify multi-dimensional reconciliation
      expect(cycleResult.reconciliation.isReconciled).toBe(true);
      expect(cycleResult.reconciliation.status).toBe('RECONCILED');
      expect(cycleResult.reconciliation.discrepancies).toEqual([]);
      expect(cycleResult.reconciliation.quantityReconciliation.passed).toBe(true);
      expect(cycleResult.reconciliation.financialReconciliation.passed).toBe(true);
      expect(cycleResult.reconciliation.productIntegrity.passed).toBe(true);
      expect(cycleResult.reconciliation.societyIntegrity.passed).toBe(true);

      // Verify exact financial totals
      expect(Number(cycleResult.reconciliation.financialReconciliation.residentSum)).toBe(825.0);
      expect(Number(cycleResult.reconciliation.financialReconciliation.communityTotal)).toBe(825.0);
    });
  });

  // -------------------------------------------------------------------------
  // 5. HTTP API ENDPOINTS
  // -------------------------------------------------------------------------
  describe('5. Execution Layer HTTP API Endpoints', () => {
    async function createScopedResident(tag: string) {
      const { userService, sessionService } = await import('../src/identity');
      const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: `ep_exec_${tag}_${suffix}`,
        email: `exec_${tag}_${suffix}@relay.local`,
        name: `Exec User ${tag}`,
      });
      const session = await sessionService.createSession(user.id);
      const society = await prisma.society.create({
        data: {
          name: `Exec Test Society ${tag} ${suffix}`,
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
          name: `Exec User ${tag}`,
          email: `exec_res_${tag}_${suffix}@relay.local`,
          flatNumber: 'E-1',
        },
      });
      await prisma.paymentMandate.create({
        data: {
          residentId: user.residentId,
          status: 'ACTIVE',
          maximumAmount: '10000',
          purpose: 'COMMUNITY_PROCUREMENT',
          periodStart: new Date(),
        },
      });
      return { token: session.token, residentId: user.residentId, societyId: society.id };
    }

    it('POST /api/execution/payment executes payment via REST API', async () => {
      const { token, residentId, societyId } = await createScopedResident('pay');
      const validated = await requestService.validateRequest({
        residentId,
        societyId,
        productId: SEED_IDS.products.cookingOil,
        quantity: 2.0,
        unit: ProductUnit.LITRE,
        deliveryAddress: 'Tower A-101',
      });
      const order = await requestService.createResidentOrder(validated);

      const res = await request(app)
        .post('/api/execution/payment')
        .set('Authorization', `Bearer ${token}`)
        .send({
          residentOrderId: order.id,
          idempotencyKey: `API-PAY-${order.id}`,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.orderId).toBe(order.id);
      expect(res.body.data.residentOrderStatus).toBe('PAID');
      expect(res.body.data.payment.providerReference).toBeDefined();
    });

    it('POST /api/execution/supplier/order submits supplier PO via REST API', async () => {
      const { token, societyId } = await createScopedResident('po');
      const deadline = new Date(Date.now() + 8 * 3600 * 1000);
      const { order: communityOrder } = await orderService.createCommunityOrder({
        societyId,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        idempotencyKey: `API-COMM-PO-${Date.now()}`,
        items: [
          {
            productId: SEED_IDS.products.cookingOil,
            totalQuantity: '5.0000',
            negotiatedUnitPrice: '165.00',
          },
        ],
      });

      const res = await request(app)
        .post('/api/execution/supplier/order')
        .set('Authorization', `Bearer ${token}`)
        .send({
          communityOrderId: communityOrder.id,
          idempotencyKey: `API-PO-${communityOrder.id}`,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(CommunityOrderStatus.SUPPLIER_CONFIRMED);
      expect(res.body.data.po.poReference).toBeDefined();
    });

    it('POST & GET /api/execution/delivery tracks delivery via REST API', async () => {
      const { token, societyId } = await createScopedResident('deliv');
      const deadline = new Date(Date.now() + 8 * 3600 * 1000);
      const { order: communityOrder } = await orderService.createCommunityOrder({
        societyId,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        idempotencyKey: `API-COMM-DELIV-${Date.now()}`,
        items: [
          {
            productId: SEED_IDS.products.cookingOil,
            totalQuantity: '5.0000',
            negotiatedUnitPrice: '165.00',
          },
        ],
      });

      // Advance to DISPATCHED
      const advRes = await request(app)
        .post('/api/execution/delivery/advance')
        .set('Authorization', `Bearer ${token}`)
        .send({
          communityOrderId: communityOrder.id,
          targetStatus: DeliveryStatus.DISPATCHED,
        });

      expect(advRes.status).toBe(200);
      expect(advRes.body.success).toBe(true);
      expect(advRes.body.data.currentStatus || advRes.body.data.toStatus).toBe(DeliveryStatus.DISPATCHED);

      // Query GET /api/execution/delivery/:communityOrderId
      const getRes = await request(app)
        .get(`/api/execution/delivery/${communityOrder.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.success).toBe(true);
      expect(getRes.body.data.status).toBe(DeliveryStatus.DISPATCHED);
      expect(getRes.body.data.trackingCode).toBeDefined();
    });

    it('execution routes reject guests with 401 and out-of-scope orders with 403', async () => {
      const { token, residentId, societyId } = await createScopedResident('scope');
      const validated = await requestService.validateRequest({
        residentId,
        societyId,
        productId: SEED_IDS.products.cookingOil,
        quantity: 1.0,
        unit: ProductUnit.LITRE,
        deliveryAddress: 'Tower A-101',
      });
      const order = await requestService.createResidentOrder(validated);

      const guest = await request(app)
        .post('/api/execution/payment')
        .send({ residentOrderId: order.id });
      expect(guest.status).toBe(401);

      const other = await createScopedResident('scope-other');
      const cross = await request(app)
        .post('/api/execution/payment')
        .set('Authorization', `Bearer ${other.token}`)
        .send({ residentOrderId: order.id });
      expect(cross.status).toBe(403);
    });
  });
});
