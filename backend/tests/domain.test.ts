import { describe, it, expect, beforeAll } from 'vitest';
import { PrismaClient, CommunityOrderStatus, DeliveryStatus, DeliveryAllocationStatus, AuditEventType, PaymentStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { seed, SEED_IDS } from '../prisma/seed';

const prisma = new PrismaClient();

describe('Relay Domain Model & Invariants', () => {
  beforeAll(async () => {
    // Ensure database is in a seeded state before running tests
    await seed(prisma);
  });

  // 1. Society → Resident relationship
  it('1. Society → Resident relationship works correctly', async () => {
    const society = await prisma.society.findUnique({
      where: { id: SEED_IDS.society.greenview },
      include: { residents: true },
    });

    expect(society).toBeDefined();
    expect(society?.name).toBe('Greenview Residency');
    expect(society?.residents.length).toBe(6);

    const residentEmails = society?.residents.map((r) => r.email);
    expect(residentEmails).toContain('aarav.sharma@greenview.example.com');
    expect(residentEmails).toContain('riya.patel@greenview.example.com');
  });

  // 2. Resident → ResidentOrder relationship
  it('2. Resident → ResidentOrder relationship maintains privacy and ownership', async () => {
    const aarav = await prisma.resident.findUnique({
      where: { id: SEED_IDS.residents.aarav },
      include: { residentOrders: true },
    });

    expect(aarav).toBeDefined();
    expect(aarav?.residentOrders.length).toBe(1);
    expect(aarav?.residentOrders[0].id).toBe(SEED_IDS.residentOrders.orderAarav);
    expect(aarav?.residentOrders[0].status).toBe('PENDING');
  });

  // 3. ResidentOrder → OrderItem relationship
  it('3. ResidentOrder → OrderItem relationship links items and products', async () => {
    const order = await prisma.residentOrder.findUnique({
      where: { id: SEED_IDS.residentOrders.orderAarav },
      include: {
        items: {
          include: { product: true },
        },
      },
    });

    expect(order).toBeDefined();
    expect(order?.items.length).toBe(2);

    const riceItem = order?.items.find((i) => i.productId === SEED_IDS.products.rice);
    expect(riceItem).toBeDefined();
    expect(Number(riceItem?.quantity)).toBe(5.0);
    expect(riceItem?.product.unit).toBe('KG');
    expect(Number(riceItem?.totalPrice)).toBe(425.0);

    const oilItem = order?.items.find((i) => i.productId === SEED_IDS.products.cookingOil);
    expect(oilItem).toBeDefined();
    expect(Number(oilItem?.quantity)).toBe(2.0);
    expect(oilItem?.product.unit).toBe('LITRE');
    expect(Number(oilItem?.totalPrice)).toBe(330.0);
  });

  // 4. CommunityOrder → Supplier relationship
  it('4. CommunityOrder → Supplier relationship models consolidated procurement', async () => {
    const deliveryDeadline = new Date(Date.now() + 12 * 3600 * 1000); // 12-hour SLA

    const communityOrder = await prisma.communityOrder.create({
      data: {
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        status: CommunityOrderStatus.CREATED,
        totalAmount: new Prisma.Decimal('1955.00'),
        currency: 'INR',
        deliveryDeadline,
      },
      include: {
        supplier: true,
        society: true,
      },
    });

    expect(communityOrder).toBeDefined();
    expect(communityOrder.supplier.name).toBe('Sahyadri Agro Wholesalers');
    expect(communityOrder.society.name).toBe('Greenview Residency');
    expect(communityOrder.deliveryDeadline.getTime()).toBeGreaterThan(Date.now());

    // Clean up temporary test order
    await prisma.communityOrder.delete({ where: { id: communityOrder.id } });
  });

  // 5. CommunityOrder → CommunityOrderItem relationship (Aggregation verification)
  it('5. CommunityOrder → CommunityOrderItem represents aggregated demand (23kg Rice)', async () => {
    const deliveryDeadline = new Date(Date.now() + 12 * 3600 * 1000);

    const communityOrder = await prisma.communityOrder.create({
      data: {
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        status: CommunityOrderStatus.CREATED,
        totalAmount: new Prisma.Decimal('1955.00'),
        deliveryDeadline,
        items: {
          create: [
            {
              productId: SEED_IDS.products.rice,
              totalQuantity: new Prisma.Decimal('23.0000'), // 5 + 10 + 8 kg
              negotiatedUnitPrice: new Prisma.Decimal('85.00'),
              totalPrice: new Prisma.Decimal('1955.00'),
            },
          ],
        },
      },
      include: {
        items: {
          include: { product: true },
        },
      },
    });

    expect(communityOrder.items.length).toBe(1);
    expect(communityOrder.items[0].product.name).toContain('Rice');
    expect(Number(communityOrder.items[0].totalQuantity)).toBe(23.0);
    expect(Number(communityOrder.items[0].totalPrice)).toBe(1955.0);

    // Clean up
    await prisma.communityOrder.delete({ where: { id: communityOrder.id } });
  });

  // 6. Payment → PaymentMandate relationship
  it('6. Payment → PaymentMandate verifies authorization boundary (payment <= mandate max)', async () => {
    const mandate = await prisma.paymentMandate.findUnique({
      where: { id: SEED_IDS.mandates.aarav },
    });

    expect(mandate).toBeDefined();
    expect(Number(mandate?.maximumAmount)).toBe(8000.0);

    const paymentAmount = new Prisma.Decimal('755.00');

    // Invariant: payment amount must be <= authorized mandate amount
    expect(paymentAmount.lessThanOrEqualTo(mandate!.maximumAmount)).toBe(true);

    const payment = await prisma.payment.create({
      data: {
        residentOrderId: SEED_IDS.residentOrders.orderAarav,
        paymentMandateId: mandate!.id,
        amount: paymentAmount,
        currency: 'INR',
        status: PaymentStatus.AUTHORIZED,
        providerReference: 'TEST-PAY-001',
        authorizedAt: new Date(),
      },
      include: {
        paymentMandate: true,
        residentOrder: true,
      },
    });

    expect(payment).toBeDefined();
    expect(payment.paymentMandate.id).toBe(mandate!.id);
    expect(payment.residentOrder.id).toBe(SEED_IDS.residentOrders.orderAarav);
    expect(Number(payment.amount)).toBe(755.0);

    // Clean up temporary payment
    await prisma.payment.delete({ where: { id: payment.id } });
  });

  // 7. Delivery → DeliveryAllocation relationship
  it('7. Delivery → DeliveryAllocation maps consolidated fulfillment back to resident orders', async () => {
    const deliveryDeadline = new Date(Date.now() + 12 * 3600 * 1000);

    const commOrder = await prisma.communityOrder.create({
      data: {
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        status: CommunityOrderStatus.DISPATCHED,
        totalAmount: new Prisma.Decimal('1955.00'),
        deliveryDeadline,
      },
    });

    const delivery = await prisma.delivery.create({
      data: {
        communityOrderId: commOrder.id,
        status: DeliveryStatus.PREPARING,
        allocations: {
          create: [
            {
              residentOrderId: SEED_IDS.residentOrders.orderAarav,
              productId: SEED_IDS.products.rice,
              quantity: new Prisma.Decimal('5.0000'),
              status: DeliveryAllocationStatus.ALLOCATED,
            },
            {
              residentOrderId: SEED_IDS.residentOrders.orderRiya,
              productId: SEED_IDS.products.rice,
              quantity: new Prisma.Decimal('10.0000'),
              status: DeliveryAllocationStatus.ALLOCATED,
            },
            {
              residentOrderId: SEED_IDS.residentOrders.orderKabir,
              productId: SEED_IDS.products.rice,
              quantity: new Prisma.Decimal('8.0000'),
              status: DeliveryAllocationStatus.ALLOCATED,
            },
          ],
        },
      },
      include: {
        allocations: {
          include: { residentOrder: true },
        },
      },
    });

    expect(delivery.allocations.length).toBe(3);

    // Invariant: sum of resident allocations = 23 kg
    const totalAllocated = delivery.allocations.reduce(
      (sum, alloc) => sum.plus(alloc.quantity),
      new Prisma.Decimal(0)
    );
    expect(Number(totalAllocated)).toBe(23.0);

    // Clean up
    await prisma.communityOrder.delete({ where: { id: commOrder.id } });
  });

  // 8. AuditEvent persistence
  it('8. AuditEvent persistence records operational milestones without private LLM reasoning', async () => {
    const auditEvent = await prisma.auditEvent.create({
      data: {
        eventType: AuditEventType.DEMAND_AGGREGATED,
        actor: 'deterministic_core:pooling_service',
        entityType: 'CommunityOrder',
        entityId: 'test-community-order-id',
        metadata: {
          contributingOrdersCount: 3,
          product: 'Basmati Rice',
          aggregatedQuantity: 23.0,
          unit: 'KG',
          algorithm: 'deterministic_exact_sum',
        },
      },
    });

    expect(auditEvent.id).toBeDefined();
    expect(auditEvent.eventType).toBe('DEMAND_AGGREGATED');

    const retrieved = await prisma.auditEvent.findUnique({
      where: { id: auditEvent.id },
    });
    expect(retrieved).toBeDefined();
    expect((retrieved?.metadata as Record<string, unknown>).aggregatedQuantity).toBe(23.0);

    // Clean up
    await prisma.auditEvent.delete({ where: { id: auditEvent.id } });
  });

  // 9. Seed is idempotent
  it('9. Seed is idempotent (re-running seed does not duplicate records)', async () => {
    const societyCountBefore = await prisma.society.count();
    const residentCountBefore = await prisma.resident.count();
    const supplierCountBefore = await prisma.supplier.count();
    const productCountBefore = await prisma.product.count();
    const mandateCountBefore = await prisma.paymentMandate.count();
    const orderCountBefore = await prisma.residentOrder.count();

    // Run seed again
    await seed(prisma);

    const societyCountAfter = await prisma.society.count();
    const residentCountAfter = await prisma.resident.count();
    const supplierCountAfter = await prisma.supplier.count();
    const productCountAfter = await prisma.product.count();
    const mandateCountAfter = await prisma.paymentMandate.count();
    const orderCountAfter = await prisma.residentOrder.count();

    expect(societyCountAfter).toBe(societyCountBefore);
    expect(residentCountAfter).toBe(residentCountBefore);
    expect(supplierCountAfter).toBe(supplierCountBefore);
    expect(productCountAfter).toBe(productCountBefore);
    expect(mandateCountAfter).toBe(mandateCountBefore);
    expect(orderCountAfter).toBe(orderCountBefore);
  });

  // 10. Decimal money/quantity fields behave correctly
  it('10. Decimal money/quantity fields prevent JavaScript float rounding errors', () => {
    // In JavaScript floating-point: 0.1 + 0.2 === 0.30000000000000004
    const floatSum = 0.1 + 0.2;
    expect(floatSum === 0.3).toBe(false);

    // With Prisma Decimal: exact representation and zero rounding error
    const decA = new Prisma.Decimal('0.10');
    const decB = new Prisma.Decimal('0.20');
    const decSum = decA.plus(decB);

    expect(decSum.equals(new Prisma.Decimal('0.30'))).toBe(true);
    expect(decSum.toString()).toBe('0.3');

    // Monetary multi-item arithmetic
    const item1 = new Prisma.Decimal('425.00'); // 5 kg * 85
    const item2 = new Prisma.Decimal('330.00'); // 2 L * 165
    const orderTotal = item1.plus(item2);

    expect(orderTotal.equals(new Prisma.Decimal('755.00'))).toBe(true);
  });
});

