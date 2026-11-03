import { describe, it, expect } from 'vitest';
import {
  startWorkflowTool,
  getWorkflowStateTool,
  getProcurementCommitmentTool,
  getPaymentStateTool,
  getAllocationSummaryTool,
  getReconciliationStatusTool,
} from '../src/agent/tools';
import { relayOrchestrator } from '../src/orchestration';

/**
 * Bajra demo showcase: every qualified supplier's simulated commercial
 * response must be visible end-to-end — quotes, negotiation, selection —
 * with conserved financials. Discovery count varies by provider, so the
 * test asserts structural invariants (conservation, distinctness,
 * membership, equality), never an absolute supplier number.
 */
describe('Bajra demo: multi-quote commercial showcase', () => {
  it('"2 kg bajra" → quotes for all qualified → negotiation → winner → equal financials', async () => {
    const startRes = await startWorkflowTool.execute(
      { requestText: '2 kg bajra', latitude: 18.5204, longitude: 73.8567 },
      {} as any
    );
    expect(startRes.success).toBe(true);
    expect(startRes.data.status).toBe('COMPLETED');

    // Commercial evidence travels on the startWorkflow result (always called).
    const commercial = (startRes.data as any).commercial;
    expect(commercial).toBeDefined();
    const bajraWf = relayOrchestrator.getWorkflow(startRes.data.workflowId)!;
    const bajraCtx = {
      residentId: bajraWf.residentReference,
      societyId: bajraWf.societyReference,
    } as any;
    const stateRes = await getWorkflowStateTool.execute(
      { workflowId: startRes.data.workflowId },
      bajraCtx
    );
    const stateCommercial = (stateRes.data as any).commercial;
    expect(stateCommercial).toBeDefined();

    const entities = stateRes.data.entities as any;
    const quotes = commercial.quotes as any[];
    // Conservation: one normalized quote per qualified supplier.
    expect(quotes.length).toBe(entities.qualifiedSupplierIds.length);
    expect(quotes.length).toBe(entities.receivedQuoteIds.length);
    expect(quotes.length).toBeGreaterThan(1);

    // Every quote is a distinct, valid, truthfully-simulated response from a
    // real discovered supplier (no fabricated identities).
    const totals = quotes.map((q) => q.total);
    expect(new Set(totals).size).toBe(totals.length);
    const unitPrices = quotes.map((q) => q.lineItems[0].unitPrice);
    expect(new Set(unitPrices).size).toBe(unitPrices.length);
    for (const q of quotes) {
      expect(q.status).toBe('VALID');
      expect(q.isSimulated).toBe(true);
      expect(q.deliveryEtaHours).toBeGreaterThan(0);
      expect(q.deliveryEtaHours).toBeLessThanOrEqual(12);
      expect(entities.qualifiedSupplierIds).toContain(q.candidateId);
      expect(q.lineItems[0].productName).toBe('bajra');
      expect(q.lineItems[0].quotedQuantity).toBe(2);
    }

    // Eligibility evaluated for every quote under the same hard rules.
    const comparison = commercial.comparison;
    expect(comparison.quotes.length).toBe(quotes.length);
    for (const m of comparison.quotes) {
      expect(typeof m.isEligible).toBe('boolean');
      expect(Array.isArray(m.eligibilityReasons)).toBe(true);
    }

    // Negotiation evidence: actual engine sequence per negotiated quote.
    const negotiations = commercial.negotiations as any[];
    expect(negotiations.length).toBe(entities.negotiatedQuoteIds.length);
    for (const n of negotiations) {
      expect(entities.negotiatedQuoteIds).toContain(n.quoteId);
      expect(n.rationale.length).toBeGreaterThan(0);
      expect(n.finalTotal).toBeLessThan(n.initialTotal);
      expect(n.savings).toBeCloseTo(n.initialTotal - n.finalTotal, 2);
    }

    // Winner is actually selected from the competing quotes (never invented).
    const selection = commercial.selection;
    expect(selection.decision).toBe('SELECT_SUPPLIER');
    expect(quotes.map((q) => q.id)).toContain(selection.quoteId);
    expect(selection.quoteId).toBe(entities.selectedQuoteId);
    expect(selection.reason.length).toBeGreaterThan(0);

    // Financial conservation across the winning flow, read back through
    // the same evidence tools the agent and UI consume.
    const winner = quotes.find((q) => q.id === selection.quoteId)!;
    const commitmentId = entities.commitmentId as string;
    const commitmentRes: any = await getProcurementCommitmentTool.execute(
      { commitmentId },
      {} as any
    );
    const paymentRes: any = await getPaymentStateTool.execute(
      { paymentId: entities.paymentId },
      bajraCtx
    );
    const allocRes: any = await getAllocationSummaryTool.execute(
      { commitmentId },
      bajraCtx
    );
    const reconRes: any = await getReconciliationStatusTool.execute(
      { commitmentId },
      bajraCtx
    );
    expect(commitmentRes.commitment.financials.total).toBe(winner.total);
    expect(paymentRes.payment.amount).toBe(winner.total);
    expect(allocRes.totalResidentAllocatedAmount).toBe(winner.total);
    expect(reconRes.status).toBe('RECONCILED');
    expect(reconRes.discrepancyCount).toBe(0);
    expect(reconRes.isMonetaryMatched).toBe(true);
  }, 120000);
});
