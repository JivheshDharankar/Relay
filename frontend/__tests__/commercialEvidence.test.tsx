import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StageSpecificCard } from '@/components/mission/StageSpecificCards';
import { QuoteComparison } from '@/components/market/QuoteComparison';
import { getNegotiationEvidence, getQuoteEvidence } from '@/lib/workflow/runEvidence';
import { getRunIntelligence } from '@/lib/workflow/intelligence';
import { IDLE_RUN, type ProcurementRun } from '@/lib/workflow/types';
import type { StageEvidence } from '@/lib/workflow/stageEvidence';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// jsdom lacks ResizeObserver (recharts ResponsiveContainer needs it).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

function step(name: string, result: unknown) {
  return {
    step: 1,
    toolCall: { id: `call_${name}`, name, arguments: {}, result, durationMs: 5 },
  };
}

function quote(id: string, supplier: string, total: number, eta: number) {
  return {
    id,
    rfqId: 'rfq_demo',
    supplierName: supplier,
    candidateId: `geo_${id}`,
    total,
    subtotal: total - 60,
    deliveryFee: 50,
    tax: 10,
    otherCharges: 0,
    deliveryEtaHours: eta,
    validUntil: new Date(Date.now() + 86400_000).toISOString(),
    status: 'VALID',
    isSimulated: true,
    lineItems: [{ productName: 'bajra', quotedQuantity: 2, unit: 'kg', unitPrice: (total - 60) / 2 }],
  };
}

function metrics(id: string, eligible: boolean) {
  return { quoteId: id, isEligible: eligible, eligibilityReasons: eligible ? [] : ['SLA_VIOLATION'] };
}

function runWithCommercial(): ProcurementRun {
  return {
    ...IDLE_RUN,
    agentResponse: {
      success: true,
      runId: 'run-demo',
      response: 'done',
      steps: [
        step('startWorkflow', {
          success: true,
          workflowId: 'wf_demo',
          status: 'COMPLETED',
          currentStage: 'COMPLETE',
          version: 1,
          commercial: {
            quotes: [
              quote('quote_a', 'Supplier A', 400, 6),
              quote('quote_b', 'Supplier B', 350, 8),
              quote('quote_c', 'Supplier C', 500, 5),
            ],
            comparison: {
              rfqId: 'rfq_demo',
              requestedQuantity: 2,
              unit: 'kg',
              quotes: [metrics('quote_a', true), metrics('quote_b', true), metrics('quote_c', false)],
              eligibleQuoteIds: ['quote_a', 'quote_b'],
            },
            negotiations: [
              {
                quoteId: 'quote_b',
                supplierName: 'Supplier B',
                candidateId: 'geo_quote_b',
                roundNumber: 1,
                strategy: 'LOWER_PRICE',
                rationale: 'Volume discount requested.',
                expectedBenefit: 'Lower cost.',
                requestedTargetUnitPrice: 140,
                initialUnitPrice: 145,
                resultFactor: 0.98,
                finalUnitPrice: 142.1,
                initialTotal: 350,
                finalTotal: 344.2,
                savings: 5.8,
              },
            ],
            selection: {
              decision: 'SELECT_SUPPLIER',
              quoteId: 'quote_b',
              reason: 'Lowest eligible total with SLA margin.',
            },
          },
        }),
      ],
    } as never,
  };
}

function evidenceFor(stage: StageEvidence['stage']): StageEvidence {
  return { stage, label: stage, state: 'verified', summary: 'ok', facts: [], source: 'test' };
}

describe('Enriched commercial evidence mapping', () => {
  it('maps every commercial quote with eligibility and the selected winner', () => {
    const evidence = getQuoteEvidence(runWithCommercial());
    expect(evidence).not.toBeNull();
    expect(evidence!.offers).toHaveLength(3);
    expect(evidence!.offers.map((o) => o.supplierName)).toEqual([
      'Supplier A',
      'Supplier B',
      'Supplier C',
    ]);
    expect(evidence!.offers.map((o) => o.eligible)).toEqual([true, true, false]);
    expect(evidence!.offers.map((o) => o.selected)).toEqual([false, true, false]);
    expect(evidence!.offers[1].totalPrice).toBe(350);
    expect(evidence!.commercialBasisSimulated).toBe(true);
    expect(evidence!.selectionReason).toBe('Lowest eligible total with SLA margin.');
  });

  it('falls back to the single getQuote artifact when no commercial block exists', () => {
    const run: ProcurementRun = {
      ...IDLE_RUN,
      agentResponse: {
        success: true,
        runId: 'run-legacy',
        response: 'done',
        steps: [
          step('startWorkflow', { success: true, workflowId: 'wf_x', status: 'COMPLETED', currentStage: 'COMPLETE', version: 1 }),
          step('getQuote', { success: true, quote: quote('quote_a', 'Supplier A', 400, 6) }),
        ],
      } as never,
    };
    const evidence = getQuoteEvidence(run);
    expect(evidence!.offers).toHaveLength(1);
    expect(evidence!.offers[0].supplierName).toBe('Supplier A');
    expect(evidence!.selectionReason).toBeUndefined();
  });

  it('maps the negotiation sequence from enriched evidence', () => {
    const evidence = getNegotiationEvidence(runWithCommercial());
    expect(evidence).not.toBeNull();
    expect(evidence!.rounds).toHaveLength(4);
    const text = evidence!.rounds.map((r) => r.summary).join('\n');
    expect(text).toContain('Supplier B');
    expect(text).toContain('Volume discount requested');
    expect(text).toContain('344.2');
  });

  it('falls back to the generic negotiated-quote line without enriched evidence', () => {
    const run: ProcurementRun = {
      ...IDLE_RUN,
      agentResponse: {
        success: true,
        runId: 'run-legacy2',
        response: 'done',
        steps: [
          step('startWorkflow', { success: true, workflowId: 'wf_x', status: 'COMPLETED', currentStage: 'COMPLETE', version: 1 }),
          step('getWorkflowState', {
            success: true,
            data: { workflowId: 'wf_x', status: 'COMPLETED', entities: { negotiatedQuoteIds: ['quote_neg_1'] } },
          }),
        ],
      } as never,
    };
    const evidence = getNegotiationEvidence(run);
    expect(evidence!.rounds).toHaveLength(1);
    expect(evidence!.rounds[0].summary).toContain('quote_neg_1'.slice(0, 14));
  });

  it('Select card renders the backend selection reason verbatim', () => {
    const evidence = getQuoteEvidence(runWithCommercial());
    render(<StageSpecificCard evidence={evidenceFor('SELECT')} index={5} quotes={evidence} />);
    expect(screen.getByText(/Lowest eligible total with SLA margin/)).toBeTruthy();
  });

  it('QuoteComparison workspace shows the simulation disclosure and all offers', () => {
    const evidence = getQuoteEvidence(runWithCommercial());
    render(<QuoteComparison evidence={evidence!} />);
    expect(screen.getByText(/Commercial quote simulated/)).toBeTruthy();
    expect(screen.getByText('Supplier A')).toBeTruthy();
    expect(screen.getByText('Supplier B')).toBeTruthy();
    expect(screen.getByText('Supplier C')).toBeTruthy();
  });

  it('intelligence note names the selected winner, not the first offer', () => {
    const notes = getRunIntelligence(runWithCommercial());
    const select = notes.find((n) => n.stage === 'SELECT');
    expect(select).toBeDefined();
    expect(select!.lines.join('\n')).toContain('Supplier B offers the strongest price/SLA tradeoff');
    expect(select!.lines.join('\n')).not.toContain('Supplier A offers the strongest');
  });

  it('Quote card lists every competing offer with eligibility badges', () => {
    const evidence = getQuoteEvidence(runWithCommercial());
    render(<StageSpecificCard evidence={evidenceFor('QUOTE')} index={3} quotes={evidence} />);
    expect(screen.getByText('Supplier A')).toBeTruthy();
    expect(screen.getByText('Supplier B')).toBeTruthy();
    expect(screen.getByText('Supplier C')).toBeTruthy();
    expect(screen.getAllByText('Eligible')).toHaveLength(2);
    expect(screen.getByText('Ineligible')).toBeTruthy();
    expect(screen.getByText(/Commercial quote simulated/)).toBeTruthy();
  });
});
