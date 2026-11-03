'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ProcurementRun } from './types';
import { runIdOf } from './types';

const STORAGE_KEY = 'relay:run-history-v1';
const MAX_RUNS = 10;

function isStorableRun(run: ProcurementRun): boolean {
  return (
    (run.status === 'complete' || run.status === 'failed') && runIdOf(run) !== null
  );
}

function restoreRuns(): ProcurementRun[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ProcurementRun[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r) => r && isStorableRun(r));
  } catch {
    return [];
  }
}

interface RunStore {
  runs: ProcurementRun[];
  ready: boolean;
  recordRun: (run: ProcurementRun) => void;
  getRun: (runId: string) => ProcurementRun | null;
  latestRun: ProcurementRun | null;
  clearRuns: () => void;
}

const RunStoreContext = createContext<RunStore | null>(null);

export function RunStoreProvider({ children }: { children: React.ReactNode }) {
  const [runs, setRuns] = useState<ProcurementRun[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setRuns(restoreRuns());
    setReady(true);
  }, []);

  const persist = useCallback((next: ProcurementRun[]) => {
    setRuns(next);
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable: history still works in memory.
    }
  }, []);

  const recordRun = useCallback(
    (run: ProcurementRun) => {
      // Terminal runs only — including failures, which render their own
      // honest failure state and must never look like successes.
      if (!isStorableRun(run)) return;
      setRuns((prev) => {
        const id = runIdOf(run)!;
        const next = [run, ...prev.filter((r) => runIdOf(r) !== id)].slice(0, MAX_RUNS);
        try {
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
    },
    []
  );

  const getRun = useCallback(
    (runId: string) => runs.find((r) => runIdOf(r) === runId) ?? null,
    [runs]
  );

  const clearRuns = useCallback(() => {
    persist([]);
  }, [persist]);

  const value = useMemo(
    () => ({
      runs,
      ready,
      recordRun,
      getRun,
      latestRun: runs[0] ?? null,
      clearRuns,
    }),
    [runs, ready, recordRun, getRun, clearRuns]
  );

  return <RunStoreContext.Provider value={value}>{children}</RunStoreContext.Provider>;
}

export function useRunStore(): RunStore {
  const ctx = useContext(RunStoreContext);
  if (!ctx) throw new Error('useRunStore must be used within RunStoreProvider');
  return ctx;
}
