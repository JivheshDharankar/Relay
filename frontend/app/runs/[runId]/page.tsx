'use client';

import React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Container } from '@/components/ui';
import { EmptyState, LoadingState } from '@/components/feedback/Feedback';
import { AutonomousMissionControl } from '@/components/mission/AutonomousMissionControl';
import { useRunStore } from '@/lib/workflow/runStore';
import { useResidentContext } from '@/lib/session/useResidentContext';

export default function RunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const runId = params?.runId as string;
  const { getRun, ready } = useRunStore();
  const resident = useResidentContext();

  const run = ready ? getRun(runId) : null;
  const mandate = resident.mandate;

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <Link
            href="/runs"
            className="inline-flex items-center gap-1.5 text-[13px] text-relay-ink-600 hover:text-relay-ink-900 font-medium min-h-[32px]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            All runs
          </Link>

          {!ready && <LoadingState title="Loading run" />}

          {ready && !run && (
            <EmptyState
              title="Run not found"
              description="This run is not in the current tab session. Runs persist per tab; start a new mission from the command center."
              actionLabel="Go to command center"
              onAction={() => router.push('/')}
            />
          )}

          {ready && run && (
            <AutonomousMissionControl
              prompt={run.prompt}
              run={run}
              isProcessing={false}
              residentProfile={resident.profile}
              mandateLimit={mandate?.maximumAmount ?? null}
              mandateCurrency={mandate?.currency ?? 'INR'}
              onReturnToCommandCenter={() => router.push('/')}
              onRetry={(p) => router.push(`/?prompt=${encodeURIComponent(p)}`)}
              initialRevealedIndex={12}
            />
          )}
        </div>
      </Container>
    </div>
  );
}
