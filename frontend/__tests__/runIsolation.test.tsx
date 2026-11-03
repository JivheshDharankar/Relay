import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React from 'react';
import { useProcurementRun } from '@/lib/workflow/useProcurementRun';
import { RunStoreProvider, useRunStore } from '@/lib/workflow/runStore';
import { IDLE_RUN, terminalTarget, type ProcurementRun } from '@/lib/workflow/types';
import { executeFullCycle, runAgent } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, runAgent: vi.fn(), executeFullCycle: vi.fn() };
});

const mockedRunAgent = vi.mocked(runAgent);
const mockedFullCycle = vi.mocked(executeFullCycle);

const agentOk = (runId: string) => ({
  success: true,
  runId,
  response: 'done',
  steps: [
    { toolCall: { name: 'createRequest', result: { orderId: 'ord_1' } } },
    { toolCall: { name: 'createCommunityOrder', result: { order: { id: 'comm_1' } } } },
    { toolCall: { name: 'requestPayment', result: { ok: true } } },
  ],
});

const runWith = (over: Partial<ProcurementRun>): ProcurementRun => ({
  ...IDLE_RUN,
  ...over,
});

describe('terminalTarget', () => {
  it('targets the run page for terminal runs with backend ids', () => {
    expect(
      terminalTarget(runWith({ status: 'complete', agentResponse: { runId: 'r1' } as never }))
    ).toBe('/runs/r1');
    expect(
      terminalTarget(runWith({ status: 'failed', agentResponse: { runId: 'r2' } as never }))
    ).toBe('/runs/r2');
  });

  it('has no target for live runs or runs without backend ids', () => {
    expect(terminalTarget(runWith({ status: 'processing' }))).toBeNull();
    expect(terminalTarget(runWith({ status: 'idle' }))).toBeNull();
    expect(terminalTarget(runWith({ status: 'failed', agentResponse: null }))).toBeNull();
  });
});

describe('useProcurementRun command sequencing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores a stale slow response after a newer command starts', async () => {
    let resolveFirst!: (v: never) => void;
    const firstGate = new Promise<never>((res) => {
      resolveFirst = res;
    });
    mockedRunAgent.mockReturnValueOnce(firstGate).mockResolvedValueOnce(agentOk('run-new') as never);

    const { result } = renderHook(() => useProcurementRun());
    let p1!: Promise<void>;
    act(() => {
      p1 = result.current.start('first command');
    });
    await waitFor(() => expect(mockedRunAgent).toHaveBeenCalledTimes(1));
    let p2!: Promise<void>;
    act(() => {
      p2 = result.current.start('second command');
    });
    await p2;
    await waitFor(() => expect(result.current.run.prompt).toBe('second command'));
    // The stale first response arrives late with its own artifacts.
    await act(async () => {
      resolveFirst(agentOk('run-stale') as never);
      await p1;
    });
    expect(result.current.run.prompt).toBe('second command');
    expect(result.current.run.agentResponse).toMatchObject({ runId: 'run-new' });
    expect(mockedFullCycle).not.toHaveBeenCalled();
  });
});

describe('run store terminal history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RunStoreProvider>{children}</RunStoreProvider>
  );

  it('records failed runs with backend ids and restores them', async () => {
    const { result } = renderHook(() => useRunStore(), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const failed = runWith({
      status: 'failed',
      prompt: 'bad command',
      finishedAt: '2026-10-31T00:00:00.000Z',
      agentResponse: { runId: 'run-f1' } as never,
      error: { message: 'nope', code: 'X', timedOut: false, unauthorized: false },
    });
    act(() => {
      result.current.recordRun(failed);
    });
    expect(result.current.latestRun?.prompt).toBe('bad command');
    expect(JSON.parse(sessionStorage.getItem('relay:run-history-v1') || '[]')).toHaveLength(1);

    const second = renderHook(() => useRunStore(), { wrapper });
    await waitFor(() => expect(second.result.current.ready).toBe(true));
    expect(second.result.current.runs.map((r) => r.status)).toEqual(['failed']);
  });

  it('refuses live runs and runs without backend ids', async () => {
    const { result } = renderHook(() => useRunStore(), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => {
      result.current.recordRun(runWith({ status: 'processing', prompt: 'live' }));
      result.current.recordRun(runWith({ status: 'failed', prompt: 'noid', agentResponse: null }));
    });
    expect(result.current.runs).toHaveLength(0);
    expect(sessionStorage.getItem('relay:run-history-v1')).toBeNull();
  });
});
