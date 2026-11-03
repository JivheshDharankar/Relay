import { describe, it, expect } from 'vitest';
import { AllocationService } from '../src/discovery/supplier/selection/AllocationService';
import type { Quote } from '../src/discovery/supplier/quote/types';
import { MockModelProvider } from '../src/agent/model/MockModelProvider';
import { startWorkflowTool } from '../src/agent/tools/definitions';
import { relayOrchestrator } from '../src/orchestration';

/**
 * Targeted regression: multi-line commitment pricing must extend EVERY
 * quoted line independently. A quote with two products at different unit
 * prices MUST NOT price the summed quantity at lineItems[0].
 *
 * Captured real defect: rice 2×102.82 + wheat 3×89.24 (quote ₹559.76)
 * committed as 5×102.82 → ₹600.50.
 */
describe('Multi-line allocation pricing', () => {
  const svc = new AllocationService();

  function quote(
    id: string,
    lines: Array<{ productName: string; quotedQuantity: number; unit: string; unitPrice: number }>,
    charges: { deliveryFee: number; tax: number; otherCharges?: number } = { deliveryFee: 0, tax: 0 }
  ): Quote {
    const lineItems = lines.map((l) => ({
      ...l,
      lineSubtotal: Math.round(l.quotedQuantity * l.unitPrice * 100) / 100,
    }));
    const subtotal = lineItems.reduce((a, l) => a + l.lineSubtotal, 0);
    return {
      id,
      rfqId: 'rfq_test',
      candidateId: 'cand_test',
      supplierName: 'Test Supplier',
      responseId: 'resp_test',
      channel: 'email',
      currency: 'INR',
      lineItems,
      subtotal: Math.round(subtotal * 100) / 100,
      deliveryFee: charges.deliveryFee,
      tax: charges.tax,
      otherCharges: charges.otherCharges ?? 0,
      total: 0,
      status: 'VALID',
    } as unknown as Quote;
  }

  function planFor(q: Quote, quantity: number) {
    return svc.calculateAllocations(
      'commit_test',
      [{ supplierId: 'sup_test', quoteId: q.id, quantity }],
      new Map([[q.id, q]])
    );
  }

  it('1. two lines at different prices extend independently (captured case)', () => {
    const q = quote(
      'q_rice_wheat',
      [
        { productName: 'rice', quotedQuantity: 2, unit: 'kg', unitPrice: 102.82 },
        { productName: 'wheat', quotedQuantity: 3, unit: 'kg', unitPrice: 89.24 },
      ],
      { deliveryFee: 62.73, tax: 23.67 }
    );
    const plan = planFor(q, 5);
    // 2×102.82 + 3×89.24 = 205.64 + 267.72 = 473.36 (NOT 5×102.82 = 514.10)
    expect(plan.allocations[0].lineSubtotal).toBe(473.36);
    expect(plan.financials.subtotal).toBe(473.36);
    expect(plan.financials.total).toBe(559.76);
    expect(plan.allocations[0].totalAmount).toBe(559.76);
  });

  it('2. two lines at the same price equal the legacy product', () => {
    const q = quote('q_same', [
      { productName: 'rice', quotedQuantity: 2, unit: 'kg', unitPrice: 50 },
      { productName: 'wheat', quotedQuantity: 3, unit: 'kg', unitPrice: 50 },
    ]);
    const plan = planFor(q, 5);
    expect(plan.allocations[0].lineSubtotal).toBe(250);
    expect(plan.financials.total).toBe(250);
  });

  it('3. mixed units and quantities stay per-line (no contamination)', () => {
    const q = quote(
      'q_mixed',
      [
        { productName: 'banana', quotedQuantity: 5, unit: 'units', unitPrice: 12 },
        { productName: 'sugar', quotedQuantity: 2, unit: 'kg', unitPrice: 58.5 },
        { productName: 'cooking oil', quotedQuantity: 1, unit: 'liters', unitPrice: 145.25 },
      ],
      { deliveryFee: 40, tax: 10 }
    );
    const plan = planFor(q, 8);
    // 60 + 117 + 145.25 = 322.25 (first-line pricing would give 8×12 = 96)
    expect(plan.allocations[0].lineSubtotal).toBe(322.25);
    expect(plan.financials.total).toBe(372.25);
  });

  it('4. single-line quotes keep exact legacy arithmetic', () => {
    const q = quote(
      'q_single',
      [{ productName: 'sugar', quotedQuantity: 3, unit: 'kg', unitPrice: 58.5 }],
      { deliveryFee: 40, tax: 8.78 }
    );
    const plan = planFor(q, 3);
    expect(plan.allocations[0].lineSubtotal).toBe(175.5);
    expect(plan.allocations[0].agreedUnitPrice).toBe(58.5);
    expect(plan.allocations[0].totalAmount).toBe(224.28);
    expect(plan.financials.total).toBe(224.28);
  });

  it('4b. single-line split awards keep exact legacy arithmetic', () => {
    const q = quote('q_split', [
      { productName: 'sugar', quotedQuantity: 1000, unit: 'kg', unitPrice: 52 },
    ]);
    const plan = planFor(q, 600);
    expect(plan.allocations[0].lineSubtotal).toBe(31200);
    expect(plan.allocations[0].agreedUnitPrice).toBe(52);
  });

  it('5/6/7/8. end-to-end: commitment = quote lines, payment = commitment, recon exact', async () => {
    const RES = 'res_price_fix';
    const SOC = 'soc_price_fix';
    const result = (await startWorkflowTool.execute(
      {
        requestText: 'I need 2 kg sugar and 3 kg wheat within 12 hours.',
        residentReference: RES,
        societyReference: SOC,
      },
      { residentId: RES, societyId: SOC }
    )) as { success: boolean; workflowId: string };
    expect(result.success).toBe(true);

    const workflow = relayOrchestrator.getWorkflow(result.workflowId)!;
    expect(workflow.status).toBe('COMPLETED');

    const selected = (workflow as any)._selectedQuote;
    expect(selected.lineItems).toHaveLength(2);
    // No quantity contamination across lines.
    const byProduct = Object.fromEntries(
      selected.lineItems.map((l: any) => [l.productName, l.quotedQuantity])
    );
    expect(byProduct).toMatchObject({ sugar: 2, wheat: 3 });

    // Commitment derived from the actual per-line prices.
    const expectedSubtotal = selected.lineItems.reduce(
      (a: number, l: any) => a + l.unitPrice * l.quotedQuantity,
      0
    );
    const commitment = (workflow as any)._commitment;
    expect(commitment.financials.subtotal).toBeCloseTo(expectedSubtotal, 2);
    expect(commitment.financials.total).toBe(selected.total);

    // Payment equals commitment; reconciliation exact at ₹0.
    const payment = (workflow as any)._payment;
    expect(payment.amount).toBe(commitment.financials.total);
    const recon = (workflow as any)._reconciliationResult;
    expect(recon.status).toBe('RECONCILED');
    expect(recon.discrepancies).toHaveLength(0);
  }, 120000);
});
