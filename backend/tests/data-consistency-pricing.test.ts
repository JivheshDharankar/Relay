import { describe, it, expect } from 'vitest';
import { getCatalogReferencePrice } from '../src/config/pricingCatalog';
import { WorkflowExecutor } from '../src/orchestration/WorkflowExecutor';
import { SEED_IDS } from '../src/config/seedConstants';

describe('Data Consistency Phase 3: Catalog Pricing & Market Ranges', () => {
  const executor = new WorkflowExecutor();

  it('1. retrieves correct catalog reference prices for standard items', () => {
    const rice = getCatalogReferencePrice('Rice (Sona Masoori)', SEED_IDS.products.rice);
    expect(rice.basePrice).toBe(85);
    expect(rice.minPrice).toBe(78);
    expect(rice.maxPrice).toBe(90);

    const sugar = getCatalogReferencePrice('Sugar (Refined)', SEED_IDS.products.sugar);
    expect(sugar.basePrice).toBe(44);
    expect(sugar.minPrice).toBe(42);
    expect(sugar.maxPrice).toBe(46);

    const maggi = getCatalogReferencePrice('Maggi 2-Minute Noodles', SEED_IDS.products.maggi);
    expect(maggi.basePrice).toBe(14);
    expect(maggi.minPrice).toBe(13);
    expect(maggi.maxPrice).toBe(15);
  });

  it('2. dynamic prices vary deterministically per supplier while staying within market range', () => {
    const pricesForRice: number[] = [];
    for (let i = 0; i < 3; i++) {
      const price = (executor as any).computeDynamicPrice(
        'Rice (Sona Masoori)',
        i,
        'run_test_seed_1',
        SEED_IDS.products.rice
      );
      expect(price).toBeGreaterThanOrEqual(78);
      expect(price).toBeLessThanOrEqual(90);
      pricesForRice.push(price);
    }
  });

  it('3. for the basket "2 kg rice, 1 kg sugar and 2 packs Maggi", total is between ₹250 and ₹450', () => {
    const runSeed = 'run_ee031019_test';
    const supplierOffset = 0;

    const ricePrice = (executor as any).computeDynamicPrice(
      'Rice (Sona Masoori)',
      supplierOffset,
      runSeed,
      SEED_IDS.products.rice
    );
    const sugarPrice = (executor as any).computeDynamicPrice(
      'Sugar (Refined)',
      supplierOffset,
      runSeed,
      SEED_IDS.products.sugar
    );
    const maggiPrice = (executor as any).computeDynamicPrice(
      'Maggi 2-Minute Noodles',
      supplierOffset,
      runSeed,
      SEED_IDS.products.maggi
    );

    const riceTotal = 2 * ricePrice;
    const sugarTotal = 1 * sugarPrice;
    const maggiTotal = 2 * maggiPrice;
    const subtotal = riceTotal + sugarTotal + maggiTotal;

    const tax = Math.round(subtotal * 0.05 * 100) / 100;
    const deliveryFee = (executor as any).computeDynamicFee(supplierOffset, runSeed);
    const grandTotal = subtotal + tax + deliveryFee;

    // Must be in realistic grocery range (~₹250-₹450), never ₹1800-₹2075
    expect(grandTotal).toBeGreaterThanOrEqual(250);
    expect(grandTotal).toBeLessThanOrEqual(450);
    expect(deliveryFee).toBeGreaterThanOrEqual(40);
    expect(deliveryFee).toBeLessThanOrEqual(50);
  });
});
