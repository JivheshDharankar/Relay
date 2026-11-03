'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useSession } from '@/lib/session/SessionContext';
import { useProcurementRun } from './useProcurementRun';
import { useRunStore } from './runStore';
import type { ProcurementRun } from './types';

interface MissionSessionValue {
  run: ProcurementRun;
  start: (prompt: string) => Promise<void>;
  reset: () => void;
  isProcessing: boolean;
  isFailed: boolean;
  /** Demo-only presentation flag: same real mission APIs/data, compact instant layout. */
  demoMode: boolean;
  setDemoMode: (value: boolean) => void;
}

const MissionSessionContext = createContext<MissionSessionValue | null>(null);

/**
 * Mission session: the live procurement run plus demo presentation flag,
 * shared by the Command (/) and Mission (/mission) routes. Mounted in the
 * app frame (above page switches) so navigating between routes never drops
 * an in-flight mission. Terminal runs are recorded for /runs history
 * regardless of which page is mounted when the run settles.
 */
export function MissionSessionProvider({ children }: { children: React.ReactNode }) {
  const { run, start, reset, isProcessing, isFailed } = useProcurementRun();
  const { recordRun } = useRunStore();
  const { markUnauthorized } = useSession();
  const [demoMode, setDemoMode] = useState(false);

  useEffect(() => {
    if (run.error?.unauthorized) markUnauthorized();
  }, [run.error?.unauthorized, markUnauthorized]);

  // Terminal runs are recorded in store immediately so latestRun is always fresh.
  useEffect(() => {
    if (run.status !== 'complete' && run.status !== 'failed') return;
    recordRun(run);
  }, [run, recordRun]);

  const value = useMemo<MissionSessionValue>(
    () => ({ run, start, reset, isProcessing, isFailed, demoMode, setDemoMode }),
    [run, start, reset, isProcessing, isFailed, demoMode]
  );

  return <MissionSessionContext.Provider value={value}>{children}</MissionSessionContext.Provider>;
}

export function useMissionSession(): MissionSessionValue {
  const ctx = useContext(MissionSessionContext);
  if (!ctx) throw new Error('useMissionSession must be used inside MissionSessionProvider');
  return ctx;
}
