import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MissionSummaryCard } from '@/components/mission/MissionSummaryCard';
import { ProcurementProofDisplay } from '@/components/mission/ProcurementProofDisplay';
import { StageSpecificCard } from '@/components/mission/StageSpecificCards';
import { ReconPillars } from '@/components/finance/ReconPillars';
import {
  getAllocationEvidence,
  getCommitmentEvidence,
  getFulfillmentEvidence,
  getIntentEvidence,
  getPaymentEvidence,
  getReconEvidence,
} from '@/lib/workflow/runEvidence';
import { getRunIntelligence } from '@/lib/workflow/intelligence';
import { IDLE_RUN, type ProcurementRun } from '@/lib/workflow/types';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

/**
 * Final hardening — the Mission Complete financial proof must survive a run
 * where the model called NO detail getters (the sev-class gap): every money
 * value maps from the always-present financialProof snapshot, and no UI text
 * claims proof the backend did not give.
 */

function toolStep(name: string, result: unknown) {
  return {
    step: 1,
    toolCall: { id: `call_${name}`, name, arguments: {}, result, durationMs: 1 },
  };
}

const TOTAL = 468.58;

function proofOnlyResponse() {
  return {
    success: true,
    runId: 'run-proof-1',
    response: 'done',
    steps: [
      toolStep('startWorkflow', {
        success: true,
        workflowId: 'wf_proof',
        status: 'COMPLETED',
        currentStage: 'COMPLETE',
      }),
      // No getProcurementCommitment / getAllocationSummary /
      // getReconciliationStatus / getFulfillmentState calls at all.
      toolStep('getWorkflowState', {
        success: true,
        data: {
          workflowId: 'wf_proof',
          status: 'COMPLETED',
          currentStage: 'COMPLETE',
          entities: {
            residentReference: 'res_1',
            societyReference: 'soc_1',
            supplierCandidateIds: ['cand_1', 'cand_2'],
            qualifiedSupplierIds: ['cand_1', 'cand_2'],
            receivedQuoteIds: ['quote_a', 'quote_b'],
            negotiatedQuoteIds: ['quote_a'],
            selectedQuoteId: 'quote_a',
            commitmentId: 'commit_1',
            purchaseOrderIds: ['po_1'],
            paymentId: 'pmt_1',
            fulfillmentOrderIds: ['ful_1'],
            deliveryTrackingCodes: ['TRK-1'],
            residentOrderId: 'ro_1',
            rfqId: 'rfq_1',
          },
          commercial: {
            quotes: [
              { id: 'quote_a', supplierName: 'Sev Supplier A', candidateId: 'cand_1', total: TOTAL, deliveryEtaHours: 8, status: 'VALID', isSimulated: true },
              { id: 'quote_b', supplierName: 'Sev Supplier B', candidateId: 'cand_2', total: 512.0, deliveryEtaHours: 6, status: 'VALID', isSimulated: true },
            ],
            comparison: {
              quotes: [
                { quoteId: 'quote_a', isEligible: true },
                { quoteId: 'quote_b', isEligible: true },
              ],
            },
            negotiations: [],
            selection: { decision: 'SELECT_SUPPLIER', quoteId: 'quote_a', reason: 'Lowest cost eligible.' },
          },
          financialProof: {
            commitment: {
              id: 'commit_1',
              status: 'PAID',
              product: { productName: 'sev', unit: 'kg' },
              requestedQuantity: 2,
              allocations: [
                { supplierId: 'cand_1', supplierName: 'Sev Supplier A', quoteId: 'quote_a', totalAmount: TOTAL, deliveryEtaHours: 8 },
              ],
              financials: { total: TOTAL, currency: 'INR' },
              committedAt: '2026-11-02T10:00:00.000Z',
              commercialBasisSimulated: true,
            },
            payment: {
              id: 'pmt_1',
              status: 'SUCCEEDED',
              amount: TOTAL,
              currency: 'INR',
              providerTransactionId: 'TXN-PROOF-1',
              completedAt: '2026-11-02T10:01:00.000Z',
            },
            paymentSummary: {
              commitmentId: 'commit_1',
              status: 'FULLY_PAID',
              totalAmount: TOTAL,
              paidAmount: TOTAL,
              currency: 'INR',
            },
            allocation: {
              commitmentId: 'commit_1',
              status: 'FINALIZED',
              totalRequestedQuantity: 2,
              totalAllocatedQuantity: 2,
              totalProcurementCost: TOTAL,
              totalResidentAllocatedAmount: TOTAL,
              residentCount: 1,
            },
            reconciliation: {
              id: 'rec_1',
              commitmentId: 'commit_1',
              status: 'RECONCILED',
              verifiedFulfilledQuantity: 2,
              totalAllocatedQuantity: 2,
              authoritativeProcurementAmount: TOTAL,
              totalAllocatedResidentAmount: TOTAL,
              isQuantityMatched: true,
              isMonetaryMatched: true,
              isSupplierObligationsMatched: true,
              isPaymentVerified: true,
              discrepancies: [],
            },
            fulfillment: {
              id: 'ful_1',
              status: 'VERIFIED',
              trackingReference: 'TRK-1',
              supplierName: 'Sev Supplier A',
              purchaseOrderId: 'po_1',
              actualDeliveryAt: '2026-11-02T12:00:00.000Z',
              verificationEvidence: {
                evidenceType: 'DELIVERY_CONFIRMATION',
                verifiedBy: 'Society Hub Manager',
                verifiedAt: '2026-11-02T12:00:00.000Z',
                isSimulated: true,
              },
            },
          },
          sla: { requestedHours: 8, operationalGuaranteeHours: 12 },
        },
      }),
    ],
  } as unknown as ProcurementRun['agentResponse'];
}

function proofOnlyRun(): ProcurementRun {
  return { ...IDLE_RUN, status: 'complete', prompt: '2 kg sev within 8 hours', agentResponse: proofOnlyResponse() };
}

describe('Financial proof mapping from the state snapshot', () => {
  it('recon evidence exposes all four pillars with exact zero discrepancy', () => {
    const recon = getReconEvidence(proofOnlyRun());
    expect(recon).not.toBeNull();
    expect(recon!.status).toBe('RECONCILED');
    expect(recon!.isReconciled).toBe(true);
    expect(recon!.pillars).toHaveLength(4);
    expect(recon!.pillars.map((p) => p.value)).toEqual(
      [String(TOTAL), String(TOTAL), String(TOTAL), String(TOTAL)]
    );
    expect(recon!.financial.difference).toBe('0.00');
    expect(recon!.quantity.difference).toBe('0');
    expect(recon!.supplierPassed).toBe(true);
    expect(recon!.paymentPassed).toBe(true);
    expect(recon!.discrepancies).toEqual([]);
  });

  it('payment evidence carries the settled amount and provider reference', () => {
    const payment = getPaymentEvidence(proofOnlyRun());
    expect(payment).not.toBeNull();
    expect(payment!.amount).toBe(TOTAL);
    expect(payment!.status).toBe('SUCCEEDED');
    expect(payment!.providerReference).toBe('TXN-PROOF-1');
  });

  it('commitment, allocation, and fulfillment evidence resolve from the snapshot', () => {
    const run = proofOnlyRun();
    const commitment = getCommitmentEvidence(run);
    expect(commitment!.totalAmount).toBe(TOTAL);
    expect(commitment!.status).toBe('PAID');
    const allocation = getAllocationEvidence(run);
    expect(allocation!.allocationsCount).toBe(1);
    expect(allocation!.deliveryId).toBe('ful_1');
    const fulfillment = getFulfillmentEvidence(run);
    expect(fulfillment!.status).toBe('VERIFIED');
    expect(fulfillment!.trackingCode).toBe('TRK-1');
    expect(fulfillment!.verificationEvidenceType).toBe('DELIVERY_CONFIRMATION');
    expect(fulfillment!.verifiedBy).toBe('Society Hub Manager');
    expect(fulfillment!.verificationSimulated).toBe(true);
  });

  it('intent evidence discloses requested vs guaranteed SLA', () => {
    const intent = getIntentEvidence(proofOnlyRun());
    expect(intent!.requestedDeadlineHours).toBe(8);
    expect(intent!.operationalSlaHours).toBe(12);
  });

  it('proof display shows the zero-error verdict only on backend-confirmed evidence', () => {
    const recon = getReconEvidence(proofOnlyRun());
    const confirmed = render(<ProcurementProofDisplay evidence={recon} />);
    expect(confirmed.container.textContent).toContain('100% Balanced');
    expect(confirmed.container.textContent).toContain('Exact Penny Zero Error');
    confirmed.unmount();

    const missing = render(<ProcurementProofDisplay evidence={null} />);
    const text = missing.container.textContent ?? '';
    expect(text).toContain('Balance Unconfirmed');
    expect(text).not.toContain('Exact Penny Zero Error');
    expect(text).toContain('Zero error not confirmed by backend');
    // No fabricated equality: every pillar is an honest gap.
    expect(text).not.toContain('₹468.58');
  });

  it('recon pillars judge engine runs by the engine check vocabulary', () => {
    const recon = getReconEvidence(proofOnlyRun());
    const { container } = render(<ReconPillars evidence={recon!} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Supplier obligations');
    expect(text).toContain('Payment verified');
    expect(text).toContain('₹0');
  });

  it('selection card never crowns the first offer by position', () => {
    const { container } = render(
      <StageSpecificCard
        evidence={{ stage: 'SELECT', label: 'Select', state: 'verified', summary: 'ok', facts: [], source: 'x' }}
        index={5}
        quotes={{
          offers: [
            { supplierId: 'a', supplierName: 'First Supplier', totalPrice: 100, deliveryHours: 5, reliabilityScore: null, compositeScore: null, eligible: true, selected: false },
            { supplierId: 'b', supplierName: 'Second Supplier', totalPrice: 120, deliveryHours: 6, reliabilityScore: null, compositeScore: null, eligible: true, selected: false },
          ],
          selectedSupplierId: null,
          selectedSupplierName: null,
          productName: 'sev',
          quantity: 2,
          unit: 'kg',
          commercialBasisSimulated: true,
          hasNegotiatedWinner: false,
          winningTotal: null,
        }}
      />
    );
    const text = container.textContent ?? '';
    expect(text).toContain('No backend-selected winner');
    expect(text).not.toContain('First Supplier');
  });

  it('intelligence backs the strongest-quote line with a backend selection', () => {
    const notes = getRunIntelligence(proofOnlyRun());
    const select = notes.find((n) => n.stage === 'SELECT');
    // The fixture HAS a backend-selected winner, so the line is backed.
    expect(select?.lines.join(' ')).toContain('Sev Supplier A');

    // Same offers, no backend selection marker and no legacy scores:
    // the line must disappear rather than crown quote order.
    const unmarked = proofOnlyRun();
    const steps = unmarked.agentResponse!.steps.map((s) => {
      if (s.toolCall?.name !== 'getWorkflowState') return s;
      const result = JSON.parse(JSON.stringify(s.toolCall.result)) as Record<string, any>;
      delete result.data.entities.selectedQuoteId;
      result.data.commercial.selection = null;
      return { ...s, toolCall: { ...s.toolCall, result } };
    });
    const unmarkedRun: ProcurementRun = {
      ...unmarked,
      agentResponse: { ...unmarked.agentResponse!, steps: steps as never },
    };
    const unmarkedNotes = getRunIntelligence(unmarkedRun);
    const unmarkedSelect = unmarkedNotes.find((n) => n.stage === 'SELECT');
    const joined = (unmarkedSelect?.lines ?? []).join(' ');
    expect(joined).not.toContain('strongest price/SLA tradeoff');
  });
});

describe('Mission Complete display truthfulness (resume audit)', () => {
  function summaryProps(overrides: Record<string, unknown> = {}) {
    return {
      prompt: '2 kg sev',
      runId: 'run-1',
      residentOrderId: 'ro_1',
      communityOrderId: 'co_1',
      itemsDisplay: [{ name: 'sev', quantity: 2, unit: 'kg' }],
      winningSupplier: 'Sev Supplier A',
      totalAmount: 468.58,
      slaHours: 8,
      reconEvidence: null,
      onReturnToCommandCenter: () => {},
      ...overrides,
    };
  }

  it('recon pillars render the backend-reported discrepancy figure, not a literal', () => {
    const recon = getReconEvidence(proofOnlyRun());
    expect(recon!.financial.difference).toBe('0.00');
    const { container } = render(<ReconPillars evidence={recon!} />);
    const big = container.querySelector('.text-3xl');
    expect(big?.textContent).toBe(`₹${recon!.financial.difference}`);
  });

  it('unparseable validated total renders unconfirmed, never ₹0.00 settled', () => {
    const { container } = render(
      <MissionSummaryCard {...summaryProps({ totalAmount: 'not-a-number' })} />
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Total not confirmed');
    expect(text).not.toContain('Settled Under Mandate');
    expect(text).not.toContain('₹0.00');
  });

  it('missing item quantity renders an honest gap, never an invented 1', () => {
    const { container } = render(
      <MissionSummaryCard
        {...summaryProps({ itemsDisplay: [{ name: 'sugar', quantity: null, unit: 'kg' }] })}
      />
    );
    const text = container.textContent ?? '';
    expect(text).toMatch(/— kg\s*·\s*sugar/);
    expect(text).not.toMatch(/1 kg\s*·\s*sugar/);
  });
});
