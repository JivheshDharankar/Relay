import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import RunsPage from '@/app/runs/page';
import type { ProcurementRun } from '@/lib/workflow/types';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockState = vi.hoisted(() => ({ runs: [] as ProcurementRun[], ready: true }));

vi.mock('@/lib/workflow/runStore', () => ({
  useRunStore: () => ({
    runs: mockState.runs,
    latestRun: mockState.runs[0] ?? null,
    ready: mockState.ready,
    recordRun: vi.fn(),
    clearHistory: vi.fn(),
  }),
}));

function makeRun(overrides: Partial<ProcurementRun>): ProcurementRun {
  return {
    prompt: '2 kg rice',
    status: 'complete',
    startedAt: '2026-11-03T10:00:00.000Z',
    finishedAt: '2026-11-03T10:01:00.000Z',
    agentResponse: { runId: 'run-1' } as ProcurementRun['agentResponse'],
    fullCycle: null,
    residentOrderId: null,
    communityOrderId: null,
    error: null,
    ...overrides,
  };
}

describe('Runs status filters', () => {
  it('filters recorded runs by completion status with honest counts', () => {
    mockState.runs = [
      makeRun({ prompt: '2 kg rice', agentResponse: { runId: 'run-ok' } as ProcurementRun['agentResponse'] }),
      makeRun({
        prompt: '6 eggs',
        status: 'failed',
        agentResponse: { runId: 'run-bad' } as ProcurementRun['agentResponse'],
        error: { message: 'Needs clarification', code: 'AMBIGUOUS', timedOut: false, unauthorized: false },
      }),
    ];
    render(<RunsPage />);

    expect(screen.getByText(/2 kg rice/)).toBeDefined();
    expect(screen.getByText(/6 eggs/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /failed · 1/i }));
    expect(screen.queryByText(/2 kg rice/)).toBeNull();
    expect(screen.getByText(/6 eggs/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /completed · 1/i }));
    expect(screen.getByText(/2 kg rice/)).toBeDefined();
    expect(screen.queryByText(/6 eggs/)).toBeNull();
  });
});
