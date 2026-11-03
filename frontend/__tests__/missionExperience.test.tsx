import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AutonomousMissionControl } from '@/components/mission/AutonomousMissionControl';
import { ProcurementProofDisplay } from '@/components/mission/ProcurementProofDisplay';
import { StageSpecificCard } from '@/components/mission/StageSpecificCards';
import { IDLE_RUN, type ProcurementRun } from '@/lib/workflow/types';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
});

function toolStep(name: string, result: unknown) {
  return {
    step: 1,
    toolCall: { id: `call_${name}`, name, arguments: {}, result, durationMs: 1 },
  };
}

function missionRun(response: ProcurementRun['agentResponse']): ProcurementRun {
  return { ...IDLE_RUN, status: 'complete', prompt: 'test prompt', agentResponse: response };
}

function fullWorkflowResponse() {
  return {
    success: true,
    runId: 'run-ux-1',
    response: 'done',
    steps: [
      toolStep('startWorkflow', { success: true, workflowId: 'wf_1' }),
      toolStep('getWorkflowState', {
        success: true,
        data: {
          entities: {
            supplierCandidateIds: ['a'],
            qualifiedSupplierIds: ['a'],
            receivedQuoteIds: ['q1'],
            negotiatedQuoteIds: ['q1'],
            paymentId: 'pmt_1',
            selectedQuoteId: 'q1',
          },
        },
      }),
      toolStep('getQuote', {
        success: true,
        quote: {
          id: 'q1',
          status: 'VALID',
          supplierName: 'Supplier A',
          lineItems: [
            { productName: 'rice', quotedQuantity: 2, unit: 'kg', unitPrice: 100 },
            { productName: 'wheat', quotedQuantity: 3, unit: 'kg', unitPrice: 50 },
          ],
          subtotal: 350,
          tax: 17.5,
          deliveryFee: 40,
          otherCharges: 0,
          total: 407.5,
        },
      }),
      toolStep('getProcurementCommitment', {
        success: true,
        commitment: {
          id: 'commit_1',
          status: 'PAID',
          product: { productName: 'rice', unit: 'kg' },
          requestedQuantity: 5,
          allocations: [{ supplierName: 'Supplier A', totalAmount: 407.5, quoteId: 'q1', supplierId: 'a' }],
          financials: { total: 407.5, currency: 'INR' },
          deliveryDeadline: 'x',
          committedAt: 'x',
          commercialBasisSimulated: true,
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
        totalProcurementCost: 407.5,
        totalResidentAllocatedAmount: 407.5,
        residentCount: 1,
      }),
      toolStep('getFulfillmentState', {
        success: true,
        order: { id: 'ful_1', status: 'VERIFIED', trackingReference: 'TRK-1', purchaseOrderId: 'po_1', supplierName: 'Supplier A' },
      }),
    ],
  } as unknown as ProcurementRun['agentResponse'];
}

describe('One continuous mission experience', () => {
  it('renders all 13 stages compact with verified pills on one surface', () => {
    const { container } = render(
      <AutonomousMissionControl
        prompt="test prompt"
        run={missionRun(fullWorkflowResponse())}
        isProcessing={false}
        onReturnToCommandCenter={() => {}}
        onRetry={() => {}}
        initialRevealedIndex={12}
      />
    );
    const pills = container.textContent ?? '';
    expect(pills).toContain('13 / 13');
    expect(container.querySelectorAll('li').length).toBeGreaterThanOrEqual(13);
    // Compact rows: every stage header present exactly once.
    for (const label of ['Understand', 'Discover', 'Qualify', 'Quote', 'Negotiate', 'Select', 'Commit', 'Pay', 'Fulfill', 'Verify', 'Allocate', 'Reconcile', 'Complete']) {
      expect(pills).toContain(label);
    }
  });

  it('expands stage evidence inline on click without navigation', () => {
    const { container } = render(
      <AutonomousMissionControl
        prompt="test prompt"
        run={missionRun(fullWorkflowResponse())}
        isProcessing={false}
        onReturnToCommandCenter={() => {}}
        onRetry={() => {}}
        initialRevealedIndex={12}
      />
    );
    // Reduced-motion mount reveals everything instantly and auto-expands the
    // final stage; earlier stages stay compact until clicked. (The Quote
    // stage is used because it never auto-mounts, avoiding jsdom exit-animation
    // zombies from the initial mount flash.)
    const quoteToggle = screen.getByRole('button', { name: /quote stage evidence/i });
    expect(quoteToggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Initial Supplier Quotes');
    act(() => {
      fireEvent.click(quoteToggle);
    });
    expect(container.textContent).toContain('Initial Supplier Quotes');
    expect(quoteToggle.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      fireEvent.click(quoteToggle);
    });
    expect(quoteToggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('marks post-failure stages NOT RUN inside the same mission surface', () => {
    const failed = {
      success: true,
      runId: 'run-ux-fail',
      response: 'blocked',
      steps: [
        {
          step: 1,
          toolCall: { id: 'call_sw', name: 'startWorkflow', arguments: {}, result: null, durationMs: 1 },
          error: { code: 'UNMAPPABLE_PRODUCT', message: 'No match in catalog' },
        },
      ],
    } as unknown as ProcurementRun['agentResponse'];
    const { container } = render(
      <AutonomousMissionControl
        prompt="I need 3 kg cashews."
        run={missionRun(failed)}
        isProcessing={false}
        onReturnToCommandCenter={() => {}}
        onRetry={() => {}}
        initialRevealedIndex={0}
      />
    );
    const text = container.textContent ?? '';
    // Mission shell + failure stay together; original request visible.
    expect(text).toContain('Autonomous Mission Blocked');
    expect(text).toContain('I need 3 kg cashews.');
    expect(text).toContain('Edit & Retry Request');
    expect(text).toContain('Return to Command Center');
    // Stage 01 failed; the remaining 12 never ran.
    const notRunCount = (text.match(/NOT RUN/g) ?? []).length;
    expect(notRunCount).toBe(12);
    expect(text).toContain('FAILED');
    expect(text).not.toContain('MISSION COMPLETE');
  });

  it('processing state is honest about unverified stages', () => {
    const processing = { ...IDLE_RUN, status: 'processing', prompt: 'test prompt', agentResponse: null } as ProcurementRun;
    const { container } = render(
      <AutonomousMissionControl
        prompt="test prompt"
        run={processing}
        isProcessing
        onReturnToCommandCenter={() => {}}
        onRetry={() => {}}
        initialRevealedIndex={0}
      />
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Relay is orchestrating');
    expect(text).toContain('Waiting for verified backend state');
    expect(text).not.toContain('VERIFIED');
    // No invented marketing claims in the launch/loading surface.
    expect(text).not.toContain('15 km');
    expect(text).not.toContain('Zero-Markup');
    expect(text).not.toContain('Cryptographic');
  });

  it('qualify card uses backend-verified gate vocabulary only', () => {
    const { container } = render(
      <StageSpecificCard
        evidence={{ stage: 'QUALIFY', label: 'Qualify', state: 'verified', summary: 'ok', facts: [], source: 'x' }}
        index={2}
        suppliers={{ suppliers: [], eligibleCount: 2, qualifiedCount: 2 } as never}
      />
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Valid Business Info');
    expect(text).toContain('Hard SLA Window');
    expect(text).not.toContain('80%');
    expect(text).not.toContain('MOQ Compatibility');
    expect(text).not.toContain('15 km');
  });

  it('proof badge only claims balance on zero discrepancy', () => {
    const zero = render(
      <ProcurementProofDisplay
        evidence={{ pillarEvidence: { discrepancy: '0.00' }, financial: { difference: 0 } } as never}
      />
    );
    expect(zero.container.textContent).toContain('100% Balanced');
    zero.unmount();
    const unknown = render(<ProcurementProofDisplay evidence={null} />);
    expect(unknown.container.textContent).not.toContain('100% Balanced');
    expect(unknown.container.textContent).toContain('Balance Unconfirmed');
  });

  it('completion summary lists every evidenced item, never a fake fallback', () => {
    const { container } = render(
      <AutonomousMissionControl
        prompt="test prompt"
        run={missionRun(fullWorkflowResponse())}
        isProcessing={false}
        onReturnToCommandCenter={() => {}}
        onRetry={() => {}}
        initialRevealedIndex={12}
      />
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Mission Complete');
    expect(text).toContain('13 / 13');
    expect(text).toContain('2 kg · rice');
    expect(text).toContain('3 kg · wheat');
    expect(text).not.toContain('Community Batch Goods');
  });
});
