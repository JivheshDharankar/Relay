import { describe, it, expect, beforeAll } from 'vitest';
import { PrismaClient, ProductUnit, ResidentStatus, SupplierStatus, ResidentOrderStatus, CommunityOrderStatus, AuditEventType } from '@prisma/client';
import { Prisma } from '@prisma/client';
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
import {
  toDecimal,
  addDecimals,
  multiplyDecimals,
  isDecimalEqual,
  validateResidentOrderTransition,
  validateCommunityOrderTransition,
  ProcurementError,
  ProcurementErrorCode,
} from '../src/domain/procurement';

const prisma = new PrismaClient();

describe('Milestone 3 — Deterministic Procurement Engine', () => {
  beforeAll(async () => {
    // Ensure clean deterministic seeded state
    await seed(prisma);
  });

  // -------------------------------------------------------------------------
  // 1. REQUEST VALIDATION
  // -------------------------------------------------------------------------
  describe('1. Request Validation', () => {
    it('validates a well-formed procurement request successfully', async () => {
      const validated = await requestService.validateRequest({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.rice,
        quantity: 5.0,
        unit: ProductUnit.KG,
        deliveryAddress: 'Tower A-101',
      });

      expect(validated).toBeDefined();
      expect(validated.productName).toContain('Basmati Rice');
      expect(Number(validated.quantity)).toBe(5.0);
      expect(Number(validated.totalPrice)).toBe(
        Number(validated.quantity.times(validated.unitPrice))
      );
    });

    it('rejects unknown resident with RESIDENT_NOT_FOUND', async () => {
      await expect(
        requestService.validateRequest({
          residentId: '00000000-0000-0000-0000-000000000000',
          societyId: SEED_IDS.society.greenview,
          productId: SEED_IDS.products.rice,
          quantity: 5.0,
          unit: ProductUnit.KG,
          deliveryAddress: 'Tower A-101',
        })
      ).rejects.toThrowError(
        expect.objectContaining({ code: ProcurementErrorCode.RESIDENT_NOT_FOUND })
      );
    });

    it('rejects inactive resident with RESIDENT_INACTIVE', async () => {
      // Temporarily mark Neel as INACTIVE
      await prisma.resident.update({
        where: { id: SEED_IDS.residents.neel },
        data: { status: ResidentStatus.INACTIVE },
      });

      await expect(
        requestService.validateRequest({
          residentId: SEED_IDS.residents.neel,
          societyId: SEED_IDS.society.greenview,
          productId: SEED_IDS.products.rice,
          quantity: 5.0,
          unit: ProductUnit.KG,
          deliveryAddress: 'Tower C-501',
        })
      ).rejects.toThrowError(
        expect.objectContaining({ code: ProcurementErrorCode.RESIDENT_INACTIVE })
      );

      // Restore Neel to ACTIVE
      await prisma.resident.update({
        where: { id: SEED_IDS.residents.neel },
        data: { status: ResidentStatus.ACTIVE },
      });
    });

    it('rejects unknown product with PRODUCT_NOT_FOUND', async () => {
      await expect(
        requestService.validateRequest({
          residentId: SEED_IDS.residents.aarav,
          societyId: SEED_IDS.society.greenview,
          productId: '00000000-0000-0000-0000-000000000000',
          quantity: 5.0,
          unit: ProductUnit.KG,
          deliveryAddress: 'Tower A-101',
        })
      ).rejects.toThrowError(
        expect.objectContaining({ code: ProcurementErrorCode.PRODUCT_NOT_FOUND })
      );
    });

    it('rejects zero or negative quantity with INVALID_QUANTITY', async () => {
      await expect(
        requestService.validateRequest({
          residentId: SEED_IDS.residents.aarav,
          societyId: SEED_IDS.society.greenview,
          productId: SEED_IDS.products.rice,
          quantity: 0,
          unit: ProductUnit.KG,
          deliveryAddress: 'Tower A-101',
        })
      ).rejects.toThrowError(
        expect.objectContaining({ code: ProcurementErrorCode.INVALID_QUANTITY })
      );

      await expect(
        requestService.validateRequest({
          residentId: SEED_IDS.residents.aarav,
          societyId: SEED_IDS.society.greenview,
          productId: SEED_IDS.products.rice,
          quantity: -2.5,
          unit: ProductUnit.KG,
          deliveryAddress: 'Tower A-101',
        })
      ).rejects.toThrowError(
        expect.objectContaining({ code: ProcurementErrorCode.INVALID_QUANTITY })
      );
    });

    it('rejects unit mismatch with UNIT_MISMATCH', async () => {
      // Rice is measured in KG, requesting in LITRE must be rejected
      await expect(
        requestService.validateRequest({
          residentId: SEED_IDS.residents.aarav,
          societyId: SEED_IDS.society.greenview,
          productId: SEED_IDS.products.rice,
          quantity: 5.0,
          unit: ProductUnit.LITRE,
          deliveryAddress: 'Tower A-101',
        })
      ).rejects.toThrowError(
        expect.objectContaining({ code: ProcurementErrorCode.UNIT_MISMATCH })
      );
    });

    it('rejects society mismatch with SOCIETY_MISMATCH', async () => {
      // Create a foreign society
      const foreignSociety = await prisma.society.create({
        data: {
          name: 'Foreign Society',
          address: 'Mumbai',
          city: 'Mumbai',
          state: 'Maharashtra',
          postalCode: '400001',
        },
      });

      // Aarav belongs to Greenview, requesting under foreign society must fail
      await expect(
        requestService.validateRequest({
          residentId: SEED_IDS.residents.aarav,
          societyId: foreignSociety.id,
          productId: SEED_IDS.products.rice,
          quantity: 5.0,
          unit: ProductUnit.KG,
          deliveryAddress: 'Tower A-101',
        })
      ).rejects.toThrowError(
        expect.objectContaining({ code: ProcurementErrorCode.SOCIETY_MISMATCH })
      );

      await prisma.society.delete({ where: { id: foreignSociety.id } });
    });
  });

  // -------------------------------------------------------------------------
  // 2. AUTHORIZATION & SPENDING LIMITS
  // -------------------------------------------------------------------------
  describe('2. Authorization & Spending Limits', () => {
    it('authorizes request within payment mandate ceiling', async () => {
      // Aarav has max mandate ₹8,000.00
      const res = await authorizationService.checkAuthorization({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        requestedAmount: '755.00',
      });

      expect(res.authorized).toBe(true);
      expect(res.code).toBe('AUTHORIZED');
      expect(Number(res.maxAuthorizedAmount)).toBe(8000.0);
    });

    it('authorizes request exactly equal to payment mandate ceiling', async () => {
      const res = await authorizationService.checkAuthorization({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        requestedAmount: '8000.00',
      });

      expect(res.authorized).toBe(true);
      expect(res.code).toBe('AUTHORIZED');
    });

    it('rejects request exceeding payment mandate ceiling with MANDATE_LIMIT_EXCEEDED', async () => {
      const res = await authorizationService.checkAuthorization({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        requestedAmount: '8000.01',
      });

      expect(res.authorized).toBe(false);
      expect(res.code).toBe('REJECTED');
      expect(res.reason).toContain('MANDATE_LIMIT_EXCEEDED');
    });

    it('rejects expired mandate with MANDATE_PERIOD_EXPIRED', async () => {
      // Create an expired mandate for Neel
      const expiredMandate = await prisma.paymentMandate.create({
        data: {
          residentId: SEED_IDS.residents.neel,
          maximumAmount: new Prisma.Decimal('10000.00'),
          purpose: 'Testing expired period',
          periodStart: new Date('2020-01-01T00:00:00Z'),
          periodEnd: new Date('2020-12-31T23:59:59Z'),
        },
      });

      const res = await authorizationService.checkAuthorization({
        residentId: SEED_IDS.residents.neel,
        societyId: SEED_IDS.society.greenview,
        requestedAmount: '500.00',
        mandateId: expiredMandate.id,
      });

      expect(res.authorized).toBe(false);
      expect(res.code).toBe('REJECTED');
      expect(res.reason).toContain('MANDATE_PERIOD_EXPIRED');

      await prisma.paymentMandate.delete({ where: { id: expiredMandate.id } });
    });
  });

  // -------------------------------------------------------------------------
  // 3. DEMAND AGGREGATION & PRIVACY BOUNDARY
  // -------------------------------------------------------------------------
  describe('3. Demand Aggregation & Privacy Boundary', () => {
    it('aggregates seeded compatible demand: 5kg + 10kg + 8kg = 23kg Rice & 2L + 3L = 5L Oil', async () => {
      const { internalGroups, supplierFacingGroups } =
        await aggregationService.aggregateSocietyDemand(SEED_IDS.society.greenview);

      // Verify Rice aggregation
      const riceGroup = internalGroups.find((g) => g.productId === SEED_IDS.products.rice);
      expect(riceGroup).toBeDefined();
      expect(Number(riceGroup?.totalQuantity)).toBe(23.0); // 5 + 10 + 8
      expect(riceGroup?.contributingOrdersCount).toBe(3);
      expect(riceGroup?.residentDemands.length).toBe(3);

      // Verify Sunflower Oil aggregation
      const oilGroup = internalGroups.find((g) => g.productId === SEED_IDS.products.cookingOil);
      expect(oilGroup).toBeDefined();
      expect(Number(oilGroup?.totalQuantity)).toBe(5.0); // 2 + 3
      expect(oilGroup?.contributingOrdersCount).toBe(2);

      // Verify Wheat aggregation
      const wheatGroup = internalGroups.find((g) => g.productId === SEED_IDS.products.wheat);
      expect(wheatGroup).toBeDefined();
      expect(Number(wheatGroup?.totalQuantity)).toBe(5.0);

      // Verify Supplier-Facing Privacy Boundary: contains zero resident identities
      for (const sg of supplierFacingGroups) {
        expect(sg).not.toHaveProperty('residentDemands');
        expect(sg).not.toHaveProperty('residentId');
        expect(sg).not.toHaveProperty('residentName');
        expect(sg.totalQuantity).toBeDefined();
        expect(sg.contributingOrdersCount).toBeGreaterThan(0);
      }
    });

    it('never aggregates demands across different societies', async () => {
      const otherSociety = await prisma.society.create({
        data: {
          name: 'Riverside Woods',
          address: 'Kalyani Nagar',
          city: 'Pune',
          state: 'Maharashtra',
          postalCode: '411006',
        },
      });

      const { internalGroups } =
        await aggregationService.aggregateSocietyDemand(otherSociety.id);

      expect(internalGroups.length).toBe(0);

      await prisma.society.delete({ where: { id: otherSociety.id } });
    });
  });

  // -------------------------------------------------------------------------
  // 4. SUPPLIER HARD CONSTRAINTS FILTERING
  // -------------------------------------------------------------------------
  describe('4. Supplier Hard Constraints Filtering', () => {
    it('accepts active compliant supplier and rejects SLA/MOQ/service-area violations', async () => {
      // Evaluating 23 kg Rice demand for Greenview Society
      const results = await supplierService.filterEligibleSuppliers({
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.rice,
        requestedQuantity: '23.00',
        overrideDeliveryHours: {
          [SEED_IDS.suppliers.sahyadri]: 6, // 6h <= 12h SLA -> compliant
          [SEED_IDS.suppliers.deccan]: 8, // 8h <= 12h SLA -> compliant
          [SEED_IDS.suppliers.puneBulk]: 16, // 16h > 12h SLA -> SLA violation!
        },
      });

      const sahyadri = results.find((r) => r.supplierId === SEED_IDS.suppliers.sahyadri);
      expect(sahyadri?.eligible).toBe(true);
      expect(sahyadri?.reasons.length).toBe(0);

      const deccan = results.find((r) => r.supplierId === SEED_IDS.suppliers.deccan);
      expect(deccan?.eligible).toBe(true);

      const puneBulk = results.find((r) => r.supplierId === SEED_IDS.suppliers.puneBulk);
      expect(puneBulk?.eligible).toBe(false);
      expect(puneBulk?.reasons.some((r) => r.includes('SLA_VIOLATION'))).toBe(true);
    });

    it('rejects supplier when order quantity is below MOQ', async () => {
      // Pune Bulk has MOQ 25kg for rice. Requesting 10kg must trigger MOQ_NOT_MET
      const results = await supplierService.filterEligibleSuppliers({
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.rice,
        requestedQuantity: '10.00',
        overrideDeliveryHours: {
          [SEED_IDS.suppliers.puneBulk]: 8,
        },
      });

      const puneBulk = results.find((r) => r.supplierId === SEED_IDS.suppliers.puneBulk);
      expect(puneBulk?.eligible).toBe(false);
      expect(puneBulk?.reasons.some((r) => r.includes('MOQ_NOT_MET'))).toBe(true);
    });

    it('rejects supplier when product is not carried in catalog', async () => {
      // Sahyadri carries Rice, Wheat, Cooking Oil. It does NOT carry Detergent.
      const results = await supplierService.filterEligibleSuppliers({
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.detergent,
        requestedQuantity: '10.00',
      });

      const sahyadri = results.find((r) => r.supplierId === SEED_IDS.suppliers.sahyadri);
      expect(sahyadri?.eligible).toBe(false);
      expect(sahyadri?.reasons).toContain('PRODUCT_NOT_CARRIED');
    });

    it('rejects inactive supplier with SUPPLIER_INACTIVE', async () => {
      await prisma.supplier.update({
        where: { id: SEED_IDS.suppliers.sahyadri },
        data: { status: SupplierStatus.INACTIVE },
      });

      const results = await supplierService.filterEligibleSuppliers({
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.rice,
        requestedQuantity: '23.00',
      });

      const sahyadri = results.find((r) => r.supplierId === SEED_IDS.suppliers.sahyadri);
      expect(sahyadri?.eligible).toBe(false);
      expect(sahyadri?.reasons).toContain('SUPPLIER_INACTIVE');

      await prisma.supplier.update({
        where: { id: SEED_IDS.suppliers.sahyadri },
        data: { status: SupplierStatus.ACTIVE },
      });
    });
  });

  // -------------------------------------------------------------------------
  // 5. OFFER EVALUATION & DETERMINISTIC RANKING
  // -------------------------------------------------------------------------
  describe('5. Offer Evaluation & Deterministic Ranking', () => {
    it('ensures hard constraints ALWAYS beat cheaper price (cheaper ineligible offer rejected)', async () => {
      // Pune Bulk offers cheaper rice (₹78/kg = ₹1794 total), but has a 16h delivery time (>12h SLA)
      // Sahyadri offers ₹85/kg = ₹1955 total, with 6h delivery (<=12h SLA)
      const ranked = await offerService.evaluateOffers({
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.rice,
        totalQuantity: '23.00',
        customQuotes: [
          {
            supplierId: SEED_IDS.suppliers.puneBulk,
            unitPrice: '78.00',
            deliveryHours: 16, // Violates 12h SLA!
          },
          {
            supplierId: SEED_IDS.suppliers.sahyadri,
            unitPrice: '85.00',
            deliveryHours: 6, // Compliant
          },
        ],
      });

      expect(ranked.length).toBe(2);

      // Sahyadri MUST rank first because Pune Bulk is ineligible due to SLA violation!
      expect(ranked[0].supplierId).toBe(SEED_IDS.suppliers.sahyadri);
      expect(ranked[0].hardConstraintPassed).toBe(true);
      expect(ranked[0].compositeScore).toBeGreaterThan(0);

      expect(ranked[1].supplierId).toBe(SEED_IDS.suppliers.puneBulk);
      expect(ranked[1].hardConstraintPassed).toBe(false);
      expect(ranked[1].compositeScore).toBe(0.0);
    });

    it('selects best compliant offer deterministically', async () => {
      const best = await offerService.selectBestOffer({
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.rice,
        totalQuantity: '23.00',
        customQuotes: [
          {
            supplierId: SEED_IDS.suppliers.sahyadri,
            unitPrice: '85.00',
            deliveryHours: 6,
          },
          {
            supplierId: SEED_IDS.suppliers.deccan,
            unitPrice: '90.00',
            deliveryHours: 5,
          },
        ],
      });

      expect(best.hardConstraintPassed).toBe(true);
      expect(best.supplierId).toBe(SEED_IDS.suppliers.sahyadri); // Better price & high reliability wins
      expect(best.compositeScore).toBeGreaterThan(0.7);
    });

    it('validates negotiated offer boundaries (price <= initial, turnaround <= 12h)', async () => {
      // Initial offer ₹2,000, negotiated down to ₹1,850 in 6 hours -> Valid
      const finalPrice = await offerService.validateNegotiatedOffer(
        SEED_IDS.suppliers.sahyadri,
        SEED_IDS.products.rice,
        '23.00',
        '2000.00',
        '1850.00',
        6
      );
      expect(finalPrice.equals(new Prisma.Decimal('1850.00'))).toBe(true);

      // Attempting to increase price beyond initial offer must be rejected
      await expect(
        offerService.validateNegotiatedOffer(
          SEED_IDS.suppliers.sahyadri,
          SEED_IDS.products.rice,
          '23.00',
          '2000.00',
          '2100.00',
          6
        )
      ).rejects.toThrowError(
        expect.objectContaining({ code: ProcurementErrorCode.OFFER_INVALID })
      );

      // Attempting delivery beyond 12 hours must be rejected
      await expect(
        offerService.validateNegotiatedOffer(
          SEED_IDS.suppliers.sahyadri,
          SEED_IDS.products.rice,
          '23.00',
          '2000.00',
          '1850.00',
          14
        )
      ).rejects.toThrowError(
        expect.objectContaining({ code: ProcurementErrorCode.SLA_VIOLATION })
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. COMMUNITY ORDER CREATION & ATOMICITY
  // -------------------------------------------------------------------------
  describe('6. Community Order Creation & Atomicity', () => {
    it('creates a community order atomically with exact line-item calculations', async () => {
      const deadline = new Date(Date.now() + 8 * 3600 * 1000); // 8 hours (within 12h SLA)

      const { order, isDuplicate } = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        idempotencyKey: 'IDEMP-COMM-ORDER-TEST-001',
        items: [
          {
            productId: SEED_IDS.products.rice,
            totalQuantity: '23.0000',
            negotiatedUnitPrice: '85.00', // 23 * 85 = ₹1,955.00
          },
          {
            productId: SEED_IDS.products.cookingOil,
            totalQuantity: '5.0000',
            negotiatedUnitPrice: '165.00', // 5 * 165 = ₹825.00
          },
        ],
        contributingResidentOrderIds: [
          SEED_IDS.residentOrders.orderAarav,
          SEED_IDS.residentOrders.orderRiya,
        ],
      });

      expect(isDuplicate).toBe(false);
      expect(order.id).toBeDefined();
      expect(order.status).toBe(CommunityOrderStatus.CREATED);
      // Deterministic total: 1955 + 825 = 2780.00
      expect(order.totalAmount.equals(new Prisma.Decimal('2780.00'))).toBe(true);
      expect(order.items.length).toBe(2);

      // Verify contributing resident orders were updated to PROCURED
      const aaravOrder = await prisma.residentOrder.findUnique({
        where: { id: SEED_IDS.residentOrders.orderAarav },
      });
      expect(aaravOrder?.communityOrderId).toBe(order.id);
      expect(aaravOrder?.status).toBe(ResidentOrderStatus.PROCURED);

      // Clean up test order
      await prisma.residentOrder.updateMany({
        where: { communityOrderId: order.id },
        data: { communityOrderId: null, status: ResidentOrderStatus.PENDING },
      });
      await prisma.communityOrder.delete({ where: { id: order.id } });
    });

    it('rejects community order when delivery deadline exceeds 12-hour SLA', async () => {
      const illegalDeadline = new Date(Date.now() + 15 * 3600 * 1000); // 15 hours > 12h SLA!

      await expect(
        orderService.createCommunityOrder({
          societyId: SEED_IDS.society.greenview,
          supplierId: SEED_IDS.suppliers.sahyadri,
          deliveryDeadline: illegalDeadline,
          items: [
            {
              productId: SEED_IDS.products.rice,
              totalQuantity: '23.0000',
              negotiatedUnitPrice: '85.00',
            },
          ],
        })
      ).rejects.toThrowError(
        expect.objectContaining({ code: ProcurementErrorCode.SLA_VIOLATION })
      );
    });
  });

  // -------------------------------------------------------------------------
  // 7. RESIDENT ALLOCATION ENGINE
  // -------------------------------------------------------------------------
  describe('7. Resident Allocation Engine', () => {
    it('allocates 23kg Rice exactly to Aarav (5kg) + Riya (10kg) + Kabir (8kg)', async () => {
      // Create community order for testing allocation
      const deadline = new Date(Date.now() + 6 * 3600 * 1000);
      const { order } = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        items: [
          {
            productId: SEED_IDS.products.rice,
            totalQuantity: '23.0000',
            negotiatedUnitPrice: '85.00',
          },
        ],
        contributingResidentOrderIds: [
          SEED_IDS.residentOrders.orderAarav,
          SEED_IDS.residentOrders.orderRiya,
          SEED_IDS.residentOrders.orderKabir,
        ],
      });

      const delivery = await allocationService.allocateCommunityDelivery({
        communityOrderId: order.id,
        allocations: [
          {
            residentOrderId: SEED_IDS.residentOrders.orderAarav,
            productId: SEED_IDS.products.rice,
            quantity: '5.0000',
          },
          {
            residentOrderId: SEED_IDS.residentOrders.orderRiya,
            productId: SEED_IDS.products.rice,
            quantity: '10.0000',
          },
          {
            residentOrderId: SEED_IDS.residentOrders.orderKabir,
            productId: SEED_IDS.products.rice,
            quantity: '8.0000',
          },
        ],
      });

      expect(delivery).toBeDefined();
      expect(delivery?.allocations.length).toBe(3);

      const totalAllocated = delivery?.allocations.reduce(
        (acc, curr) => acc.plus(curr.quantity),
        new Prisma.Decimal(0)
      );
      expect(Number(totalAllocated)).toBe(23.0);

      // Clean up
      await prisma.residentOrder.updateMany({
        where: { communityOrderId: order.id },
        data: { communityOrderId: null, status: ResidentOrderStatus.PENDING },
      });
      await prisma.communityOrder.delete({ where: { id: order.id } });
    });

    it('rejects allocation when quantities do not match with ALLOCATION_MISMATCH', async () => {
      const deadline = new Date(Date.now() + 6 * 3600 * 1000);
      const { order } = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        items: [
          {
            productId: SEED_IDS.products.rice,
            totalQuantity: '23.0000',
            negotiatedUnitPrice: '85.00',
          },
        ],
      });

      // Allocations sum to 22 kg instead of 23 kg (5 + 10 + 7 != 23)
      await expect(
        allocationService.allocateCommunityDelivery({
          communityOrderId: order.id,
          allocations: [
            {
              residentOrderId: SEED_IDS.residentOrders.orderAarav,
              productId: SEED_IDS.products.rice,
              quantity: '5.0000',
            },
            {
              residentOrderId: SEED_IDS.residentOrders.orderRiya,
              productId: SEED_IDS.products.rice,
              quantity: '10.0000',
            },
            {
              residentOrderId: SEED_IDS.residentOrders.orderKabir,
              productId: SEED_IDS.products.rice,
              quantity: '7.0000', // Missing 1kg!
            },
          ],
        })
      ).rejects.toThrowError(
        expect.objectContaining({ code: ProcurementErrorCode.ALLOCATION_MISMATCH })
      );

      await prisma.communityOrder.delete({ where: { id: order.id } });
    });
  });

  // -------------------------------------------------------------------------
  // 8. RECONCILIATION ENGINE
  // -------------------------------------------------------------------------
  describe('8. Reconciliation Engine', () => {
    it('successfully reconciles fully matching order across quantities and financials', async () => {
      const deadline = new Date(Date.now() + 6 * 3600 * 1000);

      // Create community order for Aarav's order (₹755.00: 5kg rice + 2L oil)
      const { order } = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        items: [
          {
            productId: SEED_IDS.products.rice,
            totalQuantity: '5.0000',
            negotiatedUnitPrice: '85.00', // ₹425.00
          },
          {
            productId: SEED_IDS.products.cookingOil,
            totalQuantity: '2.0000',
            negotiatedUnitPrice: '165.00', // ₹330.00
          },
        ],
        contributingResidentOrderIds: [SEED_IDS.residentOrders.orderAarav],
      });

      // Allocate exactly matching quantities
      await allocationService.allocateCommunityDelivery({
        communityOrderId: order.id,
        allocations: [
          {
            residentOrderId: SEED_IDS.residentOrders.orderAarav,
            productId: SEED_IDS.products.rice,
            quantity: '5.0000',
          },
          {
            residentOrderId: SEED_IDS.residentOrders.orderAarav,
            productId: SEED_IDS.products.cookingOil,
            quantity: '2.0000',
          },
        ],
      });

      const report = await reconciliationService.reconcileCommunityOrder(order.id);

      expect(report.isReconciled).toBe(true);
      expect(report.quantityReconciliation.passed).toBe(true);
      expect(report.financialReconciliation.passed).toBe(true);
      expect(report.productIntegrity.passed).toBe(true);
      expect(report.societyIntegrity.passed).toBe(true);
      expect(report.discrepancies.length).toBe(0);

      // Clean up
      await prisma.residentOrder.updateMany({
        where: { communityOrderId: order.id },
        data: { communityOrderId: null, status: ResidentOrderStatus.PENDING },
      });
      await prisma.communityOrder.delete({ where: { id: order.id } });
    });

    it('reports failure when quantities or financials do not match', async () => {
      const deadline = new Date(Date.now() + 6 * 3600 * 1000);

      const { order } = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        items: [
          {
            productId: SEED_IDS.products.rice,
            totalQuantity: '23.0000',
            negotiatedUnitPrice: '85.00',
          },
        ],
      });

      // No allocations added yet -> reconciliation must report failure
      const report = await reconciliationService.reconcileCommunityOrder(order.id);
      expect(report.isReconciled).toBe(false);
      expect(report.quantityReconciliation.passed).toBe(false);
      expect(report.discrepancies.length).toBeGreaterThan(0);

      await prisma.communityOrder.delete({ where: { id: order.id } });
    });

    it('regression: synchronizes resident-order price when winning unit price shifts (20 KG wheat: ₹40 -> ₹45)', async () => {
      // 1. Initial resident request: 20 KG wheat
      // Baseline catalog lowest price is Pune Bulk @ ₹40/KG -> initial total ₹800.00
      const validated = await requestService.validateRequest({
        residentId: SEED_IDS.residents.riya,
        societyId: SEED_IDS.society.greenview,
        productId: SEED_IDS.products.wheat,
        quantity: 20,
        unit: ProductUnit.KG,
        idempotencyKey: `IDEMP-TEST-REGRESSION-WHEAT-${Date.now()}`,
      });
      const resOrder = await requestService.createResidentOrder(validated);

      // Verify baseline initial estimate: ₹40/KG, ₹800.00 total
      expect(Number(resOrder.totalAmount)).toBe(800.0);
      const initialItem = await prisma.orderItem.findFirst({
        where: { residentOrderId: resOrder.id },
      });
      expect(Number(initialItem?.unitPrice)).toBe(40.0);
      expect(Number(initialItem?.totalPrice)).toBe(800.0);

      // 2. Winning supplier is Sahyadri with negotiated unit price ₹45/KG
      const deadline = new Date(Date.now() + 8 * 3600 * 1000);
      const { order: communityOrder } = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        idempotencyKey: `IDEMP-COMM-REGRESSION-WHEAT-${Date.now()}`,
        items: [
          {
            productId: SEED_IDS.products.wheat,
            totalQuantity: '20.0000',
            negotiatedUnitPrice: '45.00', // 20 * 45 = ₹900.00
          },
        ],
        contributingResidentOrderIds: [resOrder.id],
      });

      // Invariant: Community Order Total = ₹900.00
      expect(communityOrder.totalAmount.equals(new Prisma.Decimal('900.00'))).toBe(true);

      // Invariant: Resident Order Total synchronized = ₹900.00
      const updatedResOrder = await prisma.residentOrder.findUnique({
        where: { id: resOrder.id },
        include: { items: true },
      });
      expect(updatedResOrder).toBeDefined();
      expect(updatedResOrder!.totalAmount.equals(new Prisma.Decimal('900.00'))).toBe(true);
      expect(updatedResOrder!.items[0].unitPrice.equals(new Prisma.Decimal('45.00'))).toBe(true);
      expect(updatedResOrder!.items[0].totalPrice.equals(new Prisma.Decimal('900.00'))).toBe(true);

      // 3. Allocate delivery matching exactly 20 KG wheat
      await allocationService.allocateCommunityDelivery({
        communityOrderId: communityOrder.id,
        allocations: [
          {
            residentOrderId: resOrder.id,
            productId: SEED_IDS.products.wheat,
            quantity: '20.0000',
          },
        ],
      });

      // 4. Multi-dimensional Reconciliation
      const report = await reconciliationService.reconcileCommunityOrder(communityOrder.id);

      expect(report.isReconciled).toBe(true);
      expect(report.financialReconciliation.passed).toBe(true);
      expect(Number(report.financialReconciliation.communityTotal)).toBe(900.0);
      expect(Number(report.financialReconciliation.residentSum)).toBe(900.0);
      expect(Number(report.financialReconciliation.difference)).toBe(0.0);
      expect(report.quantityReconciliation.passed).toBe(true);
      expect(report.discrepancies.length).toBe(0);

      // Clean up test records
      await prisma.deliveryAllocation.deleteMany({
        where: { residentOrderId: resOrder.id },
      });
      await prisma.delivery.deleteMany({
        where: { communityOrderId: communityOrder.id },
      });
      await prisma.residentOrder.delete({
        where: { id: resOrder.id },
      });
      await prisma.communityOrder.delete({
        where: { id: communityOrder.id },
      });
    });
  });

  // -------------------------------------------------------------------------
  // 9. STATE MACHINE VALIDATION
  // -------------------------------------------------------------------------
  describe('9. Order State Machine', () => {
    it('accepts all valid ResidentOrder state transitions', () => {
      expect(() =>
        validateResidentOrderTransition(ResidentOrderStatus.PENDING, ResidentOrderStatus.AGGREGATING)
      ).not.toThrow();

      expect(() =>
        validateResidentOrderTransition(ResidentOrderStatus.AGGREGATING, ResidentOrderStatus.PROCURED)
      ).not.toThrow();

      expect(() =>
        validateResidentOrderTransition(ResidentOrderStatus.PROCURED, ResidentOrderStatus.PAYMENT_PENDING)
      ).not.toThrow();

      expect(() =>
        validateResidentOrderTransition(ResidentOrderStatus.PAYMENT_PENDING, ResidentOrderStatus.PAID)
      ).not.toThrow();

      expect(() =>
        validateResidentOrderTransition(ResidentOrderStatus.PAID, ResidentOrderStatus.FULFILLING)
      ).not.toThrow();

      expect(() =>
        validateResidentOrderTransition(ResidentOrderStatus.FULFILLING, ResidentOrderStatus.DELIVERED)
      ).not.toThrow();
    });

    it('rejects invalid ResidentOrder state transitions', () => {
      // DELIVERED cannot transition back to CREATED or PENDING
      expect(() =>
        validateResidentOrderTransition(ResidentOrderStatus.DELIVERED, ResidentOrderStatus.PENDING)
      ).toThrowError(
        expect.objectContaining({ code: ProcurementErrorCode.INVALID_STATE_TRANSITION })
      );

      // PENDING cannot skip directly to DELIVERED
      expect(() =>
        validateResidentOrderTransition(ResidentOrderStatus.PENDING, ResidentOrderStatus.DELIVERED)
      ).toThrowError(
        expect.objectContaining({ code: ProcurementErrorCode.INVALID_STATE_TRANSITION })
      );
    });

    it('accepts valid CommunityOrder state transitions and rejects illegal skips', () => {
      expect(() =>
        validateCommunityOrderTransition(CommunityOrderStatus.CREATED, CommunityOrderStatus.PAYMENT_AUTHORIZED)
      ).not.toThrow();

      expect(() =>
        validateCommunityOrderTransition(CommunityOrderStatus.DELIVERED, CommunityOrderStatus.RECONCILED)
      ).not.toThrow();

      // RECONCILED cannot transition backwards
      expect(() =>
        validateCommunityOrderTransition(CommunityOrderStatus.RECONCILED, CommunityOrderStatus.CREATED)
      ).toThrowError(
        expect.objectContaining({ code: ProcurementErrorCode.INVALID_STATE_TRANSITION })
      );
    });
  });

  // -------------------------------------------------------------------------
  // 10. IDEMPOTENCY
  // -------------------------------------------------------------------------
  describe('10. Idempotency', () => {
    it('returns existing CommunityOrder on identical retry without creating duplicates', async () => {
      const deadline = new Date(Date.now() + 6 * 3600 * 1000);
      const idempotencyKey = 'IDEMP-TEST-RETRY-999';

      const firstCall = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        idempotencyKey,
        items: [
          {
            productId: SEED_IDS.products.rice,
            totalQuantity: '23.0000',
            negotiatedUnitPrice: '85.00',
          },
        ],
      });

      expect(firstCall.isDuplicate).toBe(false);

      const countBefore = await prisma.communityOrder.count();

      // Second identical call with same key
      const secondCall = await orderService.createCommunityOrder({
        societyId: SEED_IDS.society.greenview,
        supplierId: SEED_IDS.suppliers.sahyadri,
        deliveryDeadline: deadline,
        idempotencyKey,
        items: [
          {
            productId: SEED_IDS.products.rice,
            totalQuantity: '23.0000',
            negotiatedUnitPrice: '85.00',
          },
        ],
      });

      expect(secondCall.isDuplicate).toBe(true);
      expect(secondCall.order.id).toBe(firstCall.order.id);

      const countAfter = await prisma.communityOrder.count();
      expect(countAfter).toBe(countBefore); // Zero duplicate records created!

      // Clean up
      await prisma.communityOrder.delete({ where: { id: firstCall.order.id } });
    });
  });

  // -------------------------------------------------------------------------
  // 11. DECIMAL MONEY & QUANTITY PRECISION
  // -------------------------------------------------------------------------
  describe('11. Decimal Precision & Zero Floating-Point Drift', () => {
    it('performs exact arithmetic without JavaScript float approximation errors', () => {
      // 0.1 + 0.2 is notoriously 0.30000000000000004 in JS floats
      const decimalSum = addDecimals('0.10', '0.20');
      expect(decimalSum.equals(new Prisma.Decimal('0.30'))).toBe(true);

      // Multi-item exact multiplication: 23 kg * ₹85.50
      const total = multiplyDecimals('23.0000', '85.50');
      expect(total.equals(new Prisma.Decimal('1966.50'))).toBe(true);

      // Sub-cent fractional pricing: 7 units * ₹12.3333 = ₹86.3331 -> rounded to ₹86.33
      const unrounded = multiplyDecimals('7.0', '12.3333');
      const rounded = toDecimal(unrounded).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      expect(rounded.equals(new Prisma.Decimal('86.33'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 12. AUDIT TRAIL LOGGING
  // -------------------------------------------------------------------------
  describe('12. Audit Trail Logging', () => {
    it('verifies operational audit events are recorded for key transitions without private LLM reasoning', async () => {
      // Trigger deterministic operations that record audit events
      await authorizationService.checkAuthorization({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        requestedAmount: '100.00',
      });

      await aggregationService.aggregateSocietyDemand(SEED_IDS.society.greenview);

      const recentEvents = await prisma.auditEvent.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
      });

      expect(recentEvents.length).toBeGreaterThan(0);

      const eventTypes = recentEvents.map((e) => e.eventType);
      // Key operational event types must be present
      expect(
        eventTypes.includes(AuditEventType.AUTHORIZATION_CHECKED) ||
        eventTypes.includes(AuditEventType.DEMAND_AGGREGATED)
      ).toBe(true);

      // Verify that no private chain-of-thought is persisted in metadata
      for (const event of recentEvents) {
        const metadataStr = JSON.stringify(event.metadata ?? {});
        expect(metadataStr).not.toContain('chainOfThought');
        expect(metadataStr).not.toContain('thinking');
        expect(metadataStr).not.toContain('prompt');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 12. COMMUNITY ORDER PRICE BINDING (model restatement is never trusted)
  // ---------------------------------------------------------------------------
  describe('12. Community order lines bind to the pinned winning selection', () => {
    const selections = {
      prod_oil: { supplierId: 'sup_a', totalQuantity: '5', totalPrice: '825' },
    };

    it('derives the deterministic unit price and ignores the restated price', async () => {
      const { bindCommunityOrderItemsToSelection } = await import(
        '../src/agent/tools/definitions'
      );
      const bound = bindCommunityOrderItemsToSelection(
        'sup_a',
        [{ productId: 'prod_oil', totalQuantity: '5', negotiatedUnitPrice: '1.00' }],
        selections
      );
      expect(bound[0].negotiatedUnitPrice).toBe('165');
    });

    it('rejects unselected products, wrong suppliers, and quantity drift', async () => {
      const { bindCommunityOrderItemsToSelection } = await import(
        '../src/agent/tools/definitions'
      );
      expect(() =>
        bindCommunityOrderItemsToSelection(
          'sup_a',
          [{ productId: 'prod_oil', totalQuantity: '5', negotiatedUnitPrice: '165' }],
          undefined
        )
      ).toThrow('selectOffer must precede createCommunityOrder');
      expect(() =>
        bindCommunityOrderItemsToSelection(
          'sup_a',
          [{ productId: 'prod_other', totalQuantity: '5', negotiatedUnitPrice: '165' }],
          selections
        )
      ).toThrow('was not part of the winning selection');
      expect(() =>
        bindCommunityOrderItemsToSelection(
          'sup_b',
          [{ productId: 'prod_oil', totalQuantity: '5', negotiatedUnitPrice: '165' }],
          selections
        )
      ).toThrow('does not match the winning supplier');
      expect(() =>
        bindCommunityOrderItemsToSelection(
          'sup_a',
          [{ productId: 'prod_oil', totalQuantity: '6', negotiatedUnitPrice: '165' }],
          selections
        )
      ).toThrow('does not match the selected');
    });

    it('supports multi-line splits of one selected product', async () => {
      const { bindCommunityOrderItemsToSelection } = await import(
        '../src/agent/tools/definitions'
      );
      const bound = bindCommunityOrderItemsToSelection(
        'sup_a',
        [
          { productId: 'prod_oil', totalQuantity: '2', negotiatedUnitPrice: '999' },
          { productId: 'prod_oil', totalQuantity: '3', negotiatedUnitPrice: '0.01' },
        ],
        selections
      );
      expect(bound[0].negotiatedUnitPrice).toBe('165');
      expect(bound[1].negotiatedUnitPrice).toBe('165');
    });
  });
});