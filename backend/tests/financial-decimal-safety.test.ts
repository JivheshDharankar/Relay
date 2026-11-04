import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  toDecimal,
  toDecimalOptional,
  toNonNegativeDecimal,
  toPositiveDecimal,
  addDecimals,
  subtractDecimals,
  multiplyDecimals,
  divideDecimals,
  roundMoney,
  isDecimalEqual,
} from '../src/domain/procurement/decimal';
import { AllocationService } from '../src/discovery/supplier/selection/AllocationService';
import { CostAllocationService } from '../src/allocation/CostAllocationService';
import { Quote } from '../src/discovery/supplier/quote/types';

describe('Financial Safety & Exact Decimal Arithmetic Invariants', () => {
  describe('1. toDecimal strict validation (Zero Tolerance for Missing Data)', () => {
    it('throws when value is undefined', () => {
      expect(() => toDecimal(undefined as any)).toThrow(
        /Cannot convert undefined or null to Decimal: required financial value is missing/
      );
    });

    it('throws when value is null', () => {
      expect(() => toDecimal(null as any)).toThrow(
        /Cannot convert undefined or null to Decimal: required financial value is missing/
      );
    });

    it('throws when value is an empty string or whitespace', () => {
      expect(() => toDecimal('')).toThrow(
        /Cannot convert empty string to Decimal: required financial value is missing/
      );
      expect(() => toDecimal('   ')).toThrow(
        /Cannot convert empty string to Decimal: required financial value is missing/
      );
    });

    it('throws when value is an invalid numeric string', () => {
      expect(() => toDecimal('abc')).toThrow(/Invalid numeric string for Decimal/);
      expect(() => toDecimal('12.34.56')).toThrow(/Invalid numeric string for Decimal/);
      expect(() => toDecimal('--50')).toThrow(/Invalid numeric string for Decimal/);
    });

    it('throws when value is NaN or Infinity', () => {
      expect(() => toDecimal(NaN)).toThrow(/Invalid numeric value for Decimal: NaN/);
      expect(() => toDecimal(Infinity)).toThrow(/Invalid numeric value for Decimal: Infinity/);
      expect(() => toDecimal(-Infinity)).toThrow(/Invalid numeric value for Decimal: -Infinity/);
    });

    it('accurately parses valid numbers, strings, and Prisma.Decimal instances', () => {
      const fromNum = toDecimal(125.5);
      const fromStr = toDecimal('125.50');
      const fromDec = toDecimal(new Prisma.Decimal('125.50'));

      expect(fromNum.equals(fromStr)).toBe(true);
      expect(fromStr.equals(fromDec)).toBe(true);
      expect(fromNum.toString()).toBe('125.5');
    });
  });

  describe('2. toDecimalOptional (Explicit Business Defaulting Only)', () => {
    it('defaults to 0 when value is undefined or null', () => {
      expect(toDecimalOptional(undefined).equals(new Prisma.Decimal(0))).toBe(true);
      expect(toDecimalOptional(null).equals(new Prisma.Decimal(0))).toBe(true);
    });

    it('allows custom default value when omitted', () => {
      expect(toDecimalOptional(undefined, 10).equals(new Prisma.Decimal(10))).toBe(true);
    });

    it('strictly validates non-null values: does NOT silently convert invalid strings to 0', () => {
      expect(() => toDecimalOptional('invalid_fee')).toThrow(/Invalid numeric string for Decimal/);
      expect(() => toDecimalOptional(NaN)).toThrow(/Invalid numeric value for Decimal: NaN/);
    });
  });

  describe('3. Non-Negative and Strictly Positive Decimal Guards', () => {
    it('toNonNegativeDecimal allows 0 and positive values, rejects negative', () => {
      expect(toNonNegativeDecimal(0).toNumber()).toBe(0);
      expect(toNonNegativeDecimal(45.5).toNumber()).toBe(45.5);
      expect(() => toNonNegativeDecimal(-0.01, 'Delivery charge')).toThrow(
        /Delivery charge cannot be negative/
      );
    });

    it('toPositiveDecimal allows positive values, rejects 0 and negative', () => {
      expect(toPositiveDecimal(1).toNumber()).toBe(1);
      expect(() => toPositiveDecimal(0, 'Quantity')).toThrow(
        /Quantity must be strictly positive/
      );
      expect(() => toPositiveDecimal(-5, 'Price')).toThrow(
        /Price must be strictly positive/
      );
    });
  });

  describe('4. AllocationService Financial Safety', () => {
    const allocationService = new AllocationService();

    it('throws when quote is missing required line-item unitPrice', () => {
      const quoteWithoutUnitPrice: Quote = {
        id: 'q_no_price',
        rfqId: 'rfq_1',
        candidateId: 'sup_1',
        supplierName: 'Supplier 1',
        lineItems: [{ productId: 'p1', productName: 'Rice', quotedQuantity: 100 } as any],
        subtotal: 0,
        deliveryFee: 40,
        tax: 0,
        otherCharges: 0,
        total: 40,
        status: 'VALID',
        receivedAt: new Date(),
        validUntil: new Date(Date.now() + 86400000),
      };

      const quoteMap = new Map([[quoteWithoutUnitPrice.id, quoteWithoutUnitPrice]]);

      expect(() =>
        allocationService.calculateAllocations(
          'commit_1',
          [{ supplierId: 'sup_1', quoteId: quoteWithoutUnitPrice.id, quantity: 100 }],
          quoteMap
        )
      ).toThrow(/missing required unitPrice/);
    });

    it('throws when quote line item has negative unitPrice', () => {
      const quoteWithNegativePrice: Quote = {
        id: 'q_neg_price',
        rfqId: 'rfq_1',
        candidateId: 'sup_1',
        supplierName: 'Supplier 1',
        lineItems: [{ productId: 'p1', productName: 'Rice', quotedQuantity: 100, unitPrice: -75, lineTotal: -7500 }],
        subtotal: -7500,
        deliveryFee: 40,
        tax: 0,
        otherCharges: 0,
        total: -7460,
        status: 'VALID',
        receivedAt: new Date(),
        validUntil: new Date(Date.now() + 86400000),
      };

      const quoteMap = new Map([[quoteWithNegativePrice.id, quoteWithNegativePrice]]);

      expect(() =>
        allocationService.calculateAllocations(
          'commit_1',
          [{ supplierId: 'sup_1', quoteId: quoteWithNegativePrice.id, quantity: 100 }],
          quoteMap
        )
      ).toThrow(/has negative unitPrice/);
    });

    it('throws when allocation quantity is zero or negative', () => {
      const quote: Quote = {
        id: 'q_valid',
        rfqId: 'rfq_1',
        candidateId: 'sup_1',
        supplierName: 'Supplier 1',
        lineItems: [{ productId: 'p1', productName: 'Rice', quotedQuantity: 100, unitPrice: 75, lineTotal: 7500 }],
        subtotal: 7500,
        deliveryFee: 40,
        tax: 0,
        otherCharges: 0,
        total: 7540,
        status: 'VALID',
        receivedAt: new Date(),
        validUntil: new Date(Date.now() + 86400000),
      };

      const quoteMap = new Map([[quote.id, quote]]);

      expect(() =>
        allocationService.calculateAllocations(
          'commit_1',
          [{ supplierId: 'sup_1', quoteId: quote.id, quantity: 0 }],
          quoteMap
        )
      ).toThrow(/quantity must be positive/);

      expect(() =>
        allocationService.calculateAllocations(
          'commit_1',
          [{ supplierId: 'sup_1', quoteId: quote.id, quantity: -10 }],
          quoteMap
        )
      ).toThrow(/quantity must be positive/);
    });

    it('throws when deliveryFee, tax, or otherCharges are negative', () => {
      const quoteNegFee: Quote = {
        id: 'q_neg_fee',
        rfqId: 'rfq_1',
        candidateId: 'sup_1',
        supplierName: 'Supplier 1',
        lineItems: [{ productId: 'p1', productName: 'Rice', quotedQuantity: 100, unitPrice: 75, lineTotal: 7500 }],
        subtotal: 7500,
        deliveryFee: -50, // Prohibited negative fee
        tax: 0,
        otherCharges: 0,
        total: 7450,
        status: 'VALID',
        receivedAt: new Date(),
        validUntil: new Date(Date.now() + 86400000),
      };

      const quoteMap = new Map([[quoteNegFee.id, quoteNegFee]]);

      expect(() =>
        allocationService.calculateAllocations(
          'commit_1',
          [{ supplierId: 'sup_1', quoteId: quoteNegFee.id, quantity: 100 }],
          quoteMap
        )
      ).toThrow(/Delivery fee cannot be negative/);
    });

    it('safely defaults optional fees (deliveryFee, tax, otherCharges) to 0 when omitted', () => {
      const quoteOmittedOptional: any = {
        id: 'q_omitted_opt',
        rfqId: 'rfq_1',
        candidateId: 'sup_1',
        supplierName: 'Supplier 1',
        lineItems: [{ productId: 'p1', productName: 'Rice', quotedQuantity: 100, unitPrice: 80, lineTotal: 8000 }],
        subtotal: 8000,
        // deliveryFee, tax, otherCharges are completely omitted
        total: 8000,
        status: 'VALID',
        receivedAt: new Date(),
        validUntil: new Date(Date.now() + 86400000),
      };

      const quoteMap = new Map([[quoteOmittedOptional.id, quoteOmittedOptional]]);

      const plan = allocationService.calculateAllocations(
        'commit_1',
        [{ supplierId: 'sup_1', quoteId: quoteOmittedOptional.id, quantity: 100 }],
        quoteMap
      );

      expect(plan.allocations[0].deliveryFee).toBe(0);
      expect(plan.allocations[0].tax).toBe(0);
      expect(plan.allocations[0].otherCharges).toBe(0);
      expect(plan.allocations[0].lineSubtotal).toBe(8000);
      expect(plan.allocations[0].totalAmount).toBe(8000);
      expect(plan.financials.total).toBe(8000);
    });
  });

  describe('5. Component Reconciliation & Invoice Arithmetic', () => {
    const costAllocationService = new CostAllocationService();

    it('throws AllocationValidationError when component amounts do not sum to total', () => {
      expect(() =>
        costAllocationService.allocateCosts(
          [
            {
              residentOrderId: 'ro_1',
              demandLineId: 'dl_1',
              residentReference: 'res_1',
              allocatedQuantity: 10,
              totalRequestedQuantity: 10,
              fulfillmentRatio: 1,
            },
          ],
          {
            subtotal: 1000,
            tax: 50,
            deliveryFee: 40,
            otherCharges: 10,
            total: 1200, // Should be 1100, deliberate mismatch of 100
          }
        )
      ).toThrow(/sum to ₹1100, which does not match total ₹1200/);
    });

    it('throws when required subtotal is missing/undefined', () => {
      expect(() =>
        costAllocationService.allocateCosts(
          [
            {
              residentOrderId: 'ro_1',
              demandLineId: 'dl_1',
              residentReference: 'res_1',
              allocatedQuantity: 10,
              totalRequestedQuantity: 10,
              fulfillmentRatio: 1,
            },
          ],
          {
            subtotal: undefined as any,
            tax: 50,
            deliveryFee: 40,
            otherCharges: 10,
            total: 1100,
          }
        )
      ).toThrow(/Cannot convert undefined or null to Decimal: required financial value is missing/);
    });

    it('exact Prisma.Decimal arithmetic eliminates JavaScript float rounding drift', () => {
      // 0.1 + 0.2 in standard JS is 0.30000000000000004
      expect(0.1 + 0.2 === 0.3).toBe(false);

      // In Decimal arithmetic: exactly 0.3
      const sum = addDecimals(0.1, 0.2);
      expect(sum.equals(new Prisma.Decimal('0.3'))).toBe(true);
      expect(roundMoney(sum).toString()).toBe('0.3');
    });
  });
});
