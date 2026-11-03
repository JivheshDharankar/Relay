'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Container } from '@/components/ui';
import { AutonomousMissionControl } from '@/components/mission/AutonomousMissionControl';
import { useResidentContext } from '@/lib/session/useResidentContext';
import { useMissionSession } from '@/lib/workflow/MissionSessionContext';

/**
 * Live mission surface. Driven by the shared mission session (see
 * MissionSessionProvider), so the mission survives client-side navigation
 * between Command and Mission. A refresh or direct visit with no live run
 * honestly shows the empty state on this same URL — mission execution
 * itself is unchanged and still uses the existing backend flow.
 */
export default function MissionPage() {
  const resident = useResidentContext();
  const { run, start, reset, isProcessing, demoMode, setDemoMode } = useMissionSession();
  const router = useRouter();
  const mandate = resident.mandate;

  const returnToCommandCenter = () => {
    setDemoMode(false);
    reset();
    router.push('/');
  };

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-8 max-w-6xl mx-auto">
          {run.status === 'idle' ? (
            <div
              className="rounded-lg border border-relay-surface-border bg-white shadow-card px-6 py-12 text-center"
              role="status"
              aria-label="No active mission"
            >
              <p className="text-xl font-semibold tracking-tight text-relay-ink-900">
                No active mission
              </p>
              <p className="mt-2 text-sm text-relay-ink-500 max-w-md mx-auto">
                Missions you start from the Command Center run here. Past missions live under Runs.
              </p>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                <Link
                  href="/"
                  className="inline-flex items-center gap-2 rounded-md bg-relay-primary-600 hover:bg-relay-primary-700 px-4 py-2 text-[13px] font-semibold text-white transition-colors"
                >
                  Go to Command Center
                </Link>
                <Link
                  href="/runs"
                  className="inline-flex items-center gap-2 rounded-md border border-relay-surface-border px-4 py-2 text-[13px] font-semibold text-relay-ink-700 hover:border-relay-ink-300 transition-colors"
                >
                  View runs history
                </Link>
              </div>
            </div>
          ) : (
            <AutonomousMissionControl
              prompt={run.prompt}
              run={run}
              isProcessing={isProcessing}
              residentProfile={resident.profile}
              mandateLimit={mandate?.maximumAmount ?? null}
              mandateCurrency={mandate?.currency ?? 'INR'}
              demoMode={demoMode}
              onReturnToCommandCenter={returnToCommandCenter}
              onRetry={(p) => {
                reset();
                router.push(`/?prompt=${encodeURIComponent(p)}`);
              }}
              // Clarification continuation: re-run IN the mission view.
              // No reset, so the run never idles while Relay continues.
              onContinueMission={(p) => {
                void start(p);
              }}
            />
          )}
        </div>
      </Container>
    </div>
  );
}
