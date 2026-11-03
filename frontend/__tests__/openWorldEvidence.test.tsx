import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StageSpecificCard } from '@/components/mission/StageSpecificCards';
import { quoteLineItems, type IntentEvidence } from '@/lib/workflow/runEvidence';
import type { ProcurementRun } from '@/lib/workflow/types';
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

function intentWithItems(items: IntentEvidence['items']): IntentEvidence {
  return {
    productName: null,
    quantity: null,
    unit: null,
    orderId: null,
    requestedAmount: null,
    maxAllowed: null,
    mandateCode: null,
    groupsCount: null,
    items,
  };
}

function runWithQuoteLines(lineItems: unknown[]): ProcurementRun {
  return {
    agentResponse: {
      steps: [
        { toolCall: { name: 'getQuote', result: { quote: { lineItems } } } },
      ],
    },
  } as unknown as ProcurementRun;
}

/**
 * Open-world evidence truthfulness: Stage 01 captions and the line-item
 * mapping must reflect backend-declared identity provenance verbatim —
 * never catalog wording for open-world lines, never prompt-derived.
 */
describe('Open-world Stage 01 evidence', () => {
  it('Understand card captions a single open-world line (live milk shape)', () => {
    render(
      <StageSpecificCard
        evidence={evidenceFor('UNDERSTAND')}
        index={0}
        intent={intentWithItems([
          { productName: 'milk', quantity: 3, unit: 'liters', identitySource: 'open-world' },
        ])}
      />
    );
    expect(screen.getByText(/3 liters × milk/)).toBeTruthy();
    expect(screen.getByText(/Product understood · Open-world procurement item/)).toBeTruthy();
    expect(screen.queryByText(/Direct Resident Catalog Mapping/)).toBeNull();
  });

  it('Understand card captions mixed catalog + open-world multi-item as open-world', () => {
    render(
      <StageSpecificCard
        evidence={evidenceFor('UNDERSTAND')}
        index={0}
        intent={intentWithItems([
          { productName: 'rice', quantity: 2, unit: 'kg', identitySource: 'catalog' },
          { productName: 'milk', quantity: 3, unit: 'liters', identitySource: 'open-world' },
        ])}
      />
    );
    expect(screen.getByText(/Open-world procurement items · 2 items/)).toBeTruthy();
    expect(screen.queryByText(/Direct Resident Catalog Mapping/)).toBeNull();
  });

  it('Understand card keeps catalog caption when every line is catalog', () => {
    render(
      <StageSpecificCard
        evidence={evidenceFor('UNDERSTAND')}
        index={0}
        intent={intentWithItems([
          { productName: 'sugar', quantity: 2, unit: 'kg', identitySource: 'catalog' },
        ])}
      />
    );
    expect(screen.getByText(/Direct Resident Catalog Mapping/)).toBeTruthy();
    expect(screen.queryByText(/Open-world/)).toBeNull();
  });

  it('quoteLineItems reads engine commercial quotes when no getQuote/comparison lines exist', () => {
    const run = {
      agentResponse: {
        steps: [
          {
            toolCall: {
              name: 'getWorkflowState',
              result: {
                success: true,
                data: {
                  commercial: {
                    quotes: [
                      {
                        id: 'quote_ow',
                        lineItems: [
                          { productName: 'dog treats', quotedQuantity: 2, unit: 'packs', identitySource: 'open-world' },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        ],
      },
    } as unknown as ProcurementRun;
    expect(quoteLineItems(run)).toEqual([
      { productName: 'dog treats', quantity: 2, unit: 'packs', identitySource: 'open-world' },
    ]);
  });

  it('quoteLineItems preserves per-line identitySource and drops unknown values', () => {
    const lines = quoteLineItems(
      runWithQuoteLines([
        { productName: 'milk', quotedQuantity: 3, unit: 'liters', identitySource: 'open-world' },
        { productName: 'rice', quotedQuantity: 2, unit: 'kg', identitySource: 'catalog' },
        { productName: 'mystery', quotedQuantity: 1, unit: 'kg', identitySource: 'vendor-claimed' },
        { productName: 'plain', quotedQuantity: 1, unit: 'kg' },
      ])
    );
    expect(lines).toEqual([
      { productName: 'milk', quantity: 3, unit: 'liters', identitySource: 'open-world' },
      { productName: 'rice', quantity: 2, unit: 'kg', identitySource: 'catalog' },
      { productName: 'mystery', quantity: 1, unit: 'kg' },
      { productName: 'plain', quantity: 1, unit: 'kg' },
    ]);
  });
});
