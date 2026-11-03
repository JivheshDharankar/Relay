import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StageSpecificCard } from '@/components/mission/StageSpecificCards';
import { FailureExperienceCard } from '@/components/mission/FailureExperienceCard';
import { AutonomousMissionControl } from '@/components/mission/AutonomousMissionControl';
import { IDLE_RUN, type ProcurementRun } from '@/lib/workflow/types';
import type { StageEvidence } from '@/lib/workflow/stageEvidence';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
});

function evidenceFor(stage: StageEvidence['stage']): StageEvidence {
  return { stage, label: stage, state: 'verified', summary: 'ok', facts: [], source: 'test' };
}

/**
 * Phase 18.3 — stage cards render backend evidence verbatim. No prompt
 * parsing, no hardcoded counts, prices, or catalog data anywhere.
 */
describe('StageSpecificCard truthfulness', () => {
  it('Understand card never parses products from prompt text', () => {
    render(
      <StageSpecificCard
        evidence={evidenceFor('UNDERSTAND')}
        index={0}
        intent={null}
        promptText="I need 2 toothbrushes, 2 kg sugar, and 2 kg groundnut."
      />
    );
    expect(screen.queryByText(/Bamboo Toothbrushes/)).toBeNull();
    expect(screen.queryByText(/Cane Sugar/)).toBeNull();
    expect(screen.getByText(/No product mapping in this run yet/)).toBeTruthy();
  });

  it('Understand card renders backend intent verbatim', () => {
    render(
      <StageSpecificCard
        evidence={evidenceFor('UNDERSTAND')}
        index={0}
        intent={{
          productName: 'maida',
          quantity: 5,
          unit: 'kg',
          orderId: null,
          requestedAmount: null,
          maxAllowed: null,
          mandateCode: null,
          groupsCount: null,
          items: null,
        }}
      />
    );
    expect(screen.getByText(/5 kg × maida/)).toBeTruthy();
  });

  it('Discover card uses backend counts, never 9/3 fallbacks', () => {
    const { container } = render(
      <StageSpecificCard
        evidence={evidenceFor('DISCOVER')}
        index={1}
        suppliers={{ eligibleCount: 5, qualifiedCount: 4, suppliers: [] }}
      />
    );
    expect(container.textContent).toContain('5 Commercial Candidates Discovered');
    expect(container.textContent).not.toContain('9 Commercial Candidates');
  });

  it('Discover card shows an honest dash when counts are unknown', () => {
    const { container } = render(
      <StageSpecificCard evidence={evidenceFor('DISCOVER')} index={1} suppliers={null} />
    );
    expect(container.textContent).toContain('— Commercial Candidates Discovered');
  });

  it('Quote card renders eligibility from evidence, never a blanket badge', () => {
    const { container } = render(
      <StageSpecificCard
        evidence={evidenceFor('QUOTE')}
        index={3}
        quotes={{
          offers: [
            {
              supplierId: 'a',
              supplierName: 'Supplier A',
              totalPrice: 100,
              deliveryHours: 6,
              reliabilityScore: null,
              compositeScore: null,
              eligible: true,
              selected: true,
            },
            {
              supplierId: 'b',
              supplierName: 'Supplier B',
              totalPrice: 200,
              deliveryHours: 20,
              reliabilityScore: null,
              compositeScore: null,
              eligible: false,
              selected: false,
            },
          ],
          selectedSupplierId: 'a',
          selectedSupplierName: 'Supplier A',
          productName: 'maida',
          quantity: 5,
          unit: 'kg',
          commercialBasisSimulated: null,
          hasNegotiatedWinner: false,
          winningTotal: null,
        }}
      />
    );
    expect(container.textContent).toContain('Eligible');
    expect(container.textContent).toContain('Ineligible');
    expect(container.textContent).not.toContain('96%');
  });

  it('Pay card reflects backend payment status, never a hardcoded SUCCESS', () => {
    const { container } = render(
      <StageSpecificCard
        evidence={evidenceFor('PAY')}
        index={7}
        payment={{
          providerReference: 'pmt_1',
          status: 'PAID',
          amount: 468.58,
          currency: 'INR',
          executedAt: null,
          isDuplicate: null,
          source: 'workflow-engine',
        }}
      />
    );
    expect(container.textContent).toContain('PAID');
    expect(container.textContent).not.toContain('SUCCESS');
  });

  it('Reconcile card only claims zero when the backend confirms it', () => {
    const confirmed = render(
      <StageSpecificCard
        evidence={evidenceFor('RECONCILE')}
        index={11}
        recon={{
          status: 'RECONCILED',
          isReconciled: true,
          quantity: { passed: true, community: '5', residents: '5', difference: '0' },
          financial: {
            passed: true,
            community: '468.58',
            residents: '468.58',
            difference: '0.00',
          },
          productPassed: null,
          societyPassed: null,
          discrepancies: [],
          pillars: [],
          source: 'workflow-engine',
        }}
      />
    );
    expect(confirmed.container.textContent).toContain('Zero financial discrepancy confirmed');
    confirmed.unmount();

    const unknown = render(
      <StageSpecificCard
        evidence={evidenceFor('RECONCILE')}
        index={11}
        recon={{
          status: 'MISMATCH',
          isReconciled: false,
          quantity: { passed: true, community: '5', residents: '5', difference: null },
          financial: {
            passed: false,
            community: '468.58',
            residents: '400.00',
            difference: null,
          },
          productPassed: null,
          societyPassed: null,
          discrepancies: ['monetary mismatch'],
          pillars: [],
          source: 'workflow-engine',
        }}
      />
    );
    expect(unknown.container.textContent).toContain('Discrepancy not confirmed');
    expect(unknown.container.textContent).not.toContain('Zero financial discrepancy confirmed');
  });
});

describe('Mission header verified-count truthfulness', () => {
  function missionRun(response: ProcurementRun['agentResponse']): ProcurementRun {
    return { ...IDLE_RUN, status: 'complete', prompt: 'test', agentResponse: response };
  }

  function toolStep(name: string, result: unknown) {
    return {
      step: 1,
      toolCall: { id: `call_${name}`, name, arguments: {}, result, durationMs: 1 },
    };
  }

  it('shows 13 / 13 only when every stage is genuinely verified', () => {
    const full = {
      success: true,
      runId: 'run-full',
      response: 'done',
      steps: [
        toolStep('startWorkflow', { success: true, workflowId: 'wf_1' }),
        toolStep('getWorkflowState', {
          success: true,
          data: {
            entities: {
              supplierCandidateIds: ['a', 'b'],
              qualifiedSupplierIds: ['a'],
              receivedQuoteIds: ['q1'],
              negotiatedQuoteIds: ['q1'],
              paymentId: 'pmt_1',
              selectedQuoteId: 'q1',
            },
          },
        }),
        toolStep('getQuote', { success: true, quote: { id: 'q1', status: 'VALID' } }),
        toolStep('getProcurementCommitment', {
          success: true,
          commitment: {
            id: 'commit_1',
            status: 'PAID',
            product: { productName: 'maida', unit: 'kg' },
            requestedQuantity: 5,
            allocations: [
              {
                supplierName: 'S',
                totalAmount: 100,
                deliveryEtaHours: 8,
                quoteId: 'q1',
                supplierId: 'a',
              },
            ],
            financials: { total: 100, currency: 'INR' },
            deliveryDeadline: 'x',
            committedAt: 'x',
          },
        }),
        toolStep('getReconciliationStatus', {
          success: true,
          status: 'RECONCILED',
          isQuantityMatched: true,
          isMonetaryMatched: true,
          isSupplierObligationsMatched: true,
          isPaymentVerified: true,
          discrepancyCount: 0,
          discrepancies: [],
        }),
        toolStep('getAllocationSummary', {
          success: true,
          totalRequestedQuantity: 5,
          totalAllocatedQuantity: 5,
          totalProcurementCost: 100,
          totalResidentAllocatedAmount: 100,
          residentCount: 1,
        }),
        toolStep('getFulfillmentState', {
          success: true,
          order: {
            id: 'ful_1',
            status: 'VERIFIED',
            trackingReference: 'TRK-1',
            purchaseOrderId: 'po_1',
            supplierName: 'S',
          },
        }),
      ],
    } as unknown as ProcurementRun['agentResponse'];
    const { container } = render(
      <AutonomousMissionControl
        prompt="test"
        run={missionRun(full)}
        isProcessing={false}
        onReturnToCommandCenter={() => {}}
        onRetry={() => {}}
        initialRevealedIndex={12}
      />
    );
    expect(container.textContent).toContain('13 / 13 Stages Verified');
    expect(container.textContent).toContain('All 13 stages verified');
  });

  it('shows a partial count instead of 13 / 13 when stages lack evidence', () => {
    const partial = {
      success: true,
      runId: 'run-partial',
      response: 'done',
      steps: [
        toolStep('createRequest', {
          success: true,
          orderId: 'ord_1',
          productName: 'Sugar',
          quantity: 3,
          unit: 'KG',
        }),
      ],
    } as unknown as ProcurementRun['agentResponse'];
    const { container } = render(
      <AutonomousMissionControl
        prompt="test"
        run={missionRun(partial)}
        isProcessing={false}
        onReturnToCommandCenter={() => {}}
        onRetry={() => {}}
        initialRevealedIndex={12}
      />
    );
    expect(container.textContent).not.toContain('13 / 13 Stages Verified');
    expect(container.textContent).toContain('2 / 13 Stages Verified');
  });

  it('surfaces a returned startWorkflow failure as a halted mission', () => {
    const blocked = {
      success: false,
      runId: 'run-blocked',
      response: 'Payment authorization failed: SPENDING_LIMIT_EXCEEDED.',
      steps: [
        toolStep('startWorkflow', {
          success: false,
          error: 'Payment authorization failed: SPENDING_LIMIT_EXCEEDED.',
        }),
      ],
    } as unknown as ProcurementRun['agentResponse'];
    const { container } = render(
      <AutonomousMissionControl
        prompt="test"
        run={{ ...missionRun(blocked), status: 'failed' }}
        isProcessing={false}
        onReturnToCommandCenter={() => {}}
        onRetry={() => {}}
        initialRevealedIndex={12}
      />
    );
    expect(container.textContent).toContain('Mission execution halted at Stage 01');
    expect(container.textContent).toContain('SPENDING_LIMIT_EXCEEDED');
  });
});

describe('Final polish — multi-item, provenance, negotiated winner', () => {
  const offer = (overrides = {}) => ({
    supplierId: 'a',
    supplierName: 'Supplier A',
    totalPrice: 533.53,
    deliveryHours: 8,
    reliabilityScore: null,
    compositeScore: null,
    eligible: true,
    selected: true,
    ...overrides,
  });

  it('Understand card lists each evidenced item instead of merging quantities', () => {
    const { container } = render(
      <StageSpecificCard
        evidence={evidenceFor('UNDERSTAND')}
        index={0}
        intent={{
          productName: 'rice',
          quantity: 5,
          unit: 'kg',
          orderId: null,
          requestedAmount: null,
          maxAllowed: null,
          mandateCode: null,
          groupsCount: null,
          items: [
            { productName: 'rice', quantity: 2, unit: 'kg' },
            { productName: 'wheat', quantity: 3, unit: 'kg' },
          ],
        }}
      />
    );
    expect(container.textContent).toContain('rice');
    expect(container.textContent).toContain('wheat');
    expect(container.textContent).toContain('2 items');
    expect(container.textContent).not.toContain('5 kg');
  });

  it('Quote card discloses simulated commercial basis only when backend confirms it', () => {
    const base = {
      offers: [offer()],
      selectedSupplierId: 'a',
      selectedSupplierName: 'Supplier A',
      productName: 'rice',
      quantity: 5,
      unit: 'kg',
      hasNegotiatedWinner: false,
      winningTotal: null,
    };
    const shown = render(
      <StageSpecificCard
        evidence={evidenceFor('QUOTE')}
        index={3}
        quotes={{ ...base, commercialBasisSimulated: true }}
      />
    );
    expect(shown.container.textContent).toContain('Commercial quote simulated');
    expect(shown.container.textContent).toContain('commercial response is simulated');
    shown.unmount();

    const hidden = render(
      <StageSpecificCard
        evidence={evidenceFor('QUOTE')}
        index={3}
        quotes={{ ...base, commercialBasisSimulated: null }}
      />
    );
    expect(hidden.container.textContent).not.toContain('Commercial quote simulated');
  });

  it('Quote card labels received terms as initial when a negotiated winner exists', () => {
    const { container } = render(
      <StageSpecificCard
        evidence={evidenceFor('QUOTE')}
        index={3}
        quotes={{
          offers: [offer()],
          selectedSupplierId: 'a',
          selectedSupplierName: 'Supplier A',
          productName: 'rice',
          quantity: 5,
          unit: 'kg',
          commercialBasisSimulated: false,
          hasNegotiatedWinner: true,
          winningTotal: 500,
        }}
      />
    );
    expect(container.textContent).toContain('Initial Supplier Quotes');
  });

  it('Select card shows the winning negotiated total from commitment evidence', () => {
    const { container } = render(
      <StageSpecificCard
        evidence={evidenceFor('SELECT')}
        index={5}
        quotes={{
          offers: [offer({ totalPrice: 533.53 })],
          selectedSupplierId: 'a',
          selectedSupplierName: 'Supplier A',
          productName: 'rice',
          quantity: 5,
          unit: 'kg',
          commercialBasisSimulated: true,
          hasNegotiatedWinner: true,
          winningTotal: 500,
        }}
      />
    );
    expect(container.textContent).toContain('Winning Negotiated Quote');
    expect(container.textContent).toContain('₹500');
    expect(container.textContent).not.toContain('Validated Price');
  });

  it('Select card keeps the legacy validated price without negotiation evidence', () => {
    const { container } = render(
      <StageSpecificCard
        evidence={evidenceFor('SELECT')}
        index={5}
        quotes={{
          offers: [offer({ totalPrice: 533.53 })],
          selectedSupplierId: 'a',
          selectedSupplierName: 'Supplier A',
          productName: 'rice',
          quantity: 5,
          unit: 'kg',
          commercialBasisSimulated: null,
          hasNegotiatedWinner: false,
          winningTotal: null,
        }}
      />
    );
    expect(container.textContent).toContain('Validated Price');
    expect(container.textContent).not.toContain('Winning Negotiated Quote');
  });
});

describe('FailureExperienceCard truthfulness', () => {
  it('shows the backend message without a hardcoded catalog list', () => {
    const { container } = render(
      <FailureExperienceCard
        prompt="I need 3 icecream."
        errorCode="UNMAPPABLE_PRODUCT"
        errorMessage="No match. Supported products: Basmati Rice, Maida, Turmeric Surprise."
        onRetry={() => {}}
        onReturnToCommandCenter={() => {}}
      />
    );
    expect(container.textContent).toContain('Turmeric Surprise');
    expect(container.textContent).not.toContain('Bamboo Toothbrushes');
    expect(container.textContent).not.toContain('Sunflower Cooking Oil');
  });

  it('renders **bold** narration without literal markers', () => {
    const { container } = render(
      <FailureExperienceCard
        prompt="I need 3 kg quinoa within 12 hours."
        errorCode="UNDERSTAND_FAILED"
        errorMessage="I couldn't start procurement for **3 kg quinoa within 12 hours**. **Reason:** outside the catalog."
        onRetry={() => {}}
        onReturnToCommandCenter={() => {}}
      />
    );
    expect(container.textContent).toContain('3 kg quinoa within 12 hours');
    expect(container.textContent).toContain('Reason:');
    expect(container.textContent).not.toContain('**');
    expect(container.querySelectorAll('strong').length).toBeGreaterThan(0);
  });

  it('renders `code` narration without literal backticks', () => {
    const { container } = render(
      <FailureExperienceCard
        prompt="I need 3 kg quinoa within 12 hours."
        errorCode="UNDERSTAND_FAILED"
        errorMessage="The system returned `UNMAPPABLE_PRODUCT` and refused."
        onRetry={() => {}}
        onReturnToCommandCenter={() => {}}
      />
    );
    expect(container.textContent).toContain('UNMAPPABLE_PRODUCT');
    expect(container.textContent).not.toContain('`');
    expect(container.querySelectorAll('code').length).toBeGreaterThan(0);
  });

  it('escapes HTML in narration instead of executing it', () => {
    const { container } = render(
      <FailureExperienceCard
        prompt="I need 3 kg quinoa within 12 hours."
        errorCode="UNDERSTAND_FAILED"
        errorMessage='Rejected <script>alert(1)</script> and <img src=x onerror=alert(1)>.'
        onRetry={() => {}}
        onReturnToCommandCenter={() => {}}
      />
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>');
  });

  it('leaves unmatched markers as literal text', () => {
    const { container } = render(
      <FailureExperienceCard
        prompt="I need 3 kg quinoa within 12 hours."
        errorCode="UNDERSTAND_FAILED"
        errorMessage="A stray ** marker and `tick stay literal."
        onRetry={() => {}}
        onReturnToCommandCenter={() => {}}
      />
    );
    expect(container.textContent).toContain('A stray ** marker and `tick stay literal.');
  });
});
