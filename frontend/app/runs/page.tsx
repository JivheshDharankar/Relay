'use client';

import React from 'react';
import Link from 'next/link';
import { Radar, ArrowRight, Plus } from 'lucide-react';
import { Container, PageHeader } from '@/components/ui';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState, LoadingState } from '@/components/feedback/Feedback';
import { useRunStore } from '@/lib/workflow/runStore';
import { mapRunToStages } from '@/lib/workflow/stageEvidence';
import { runIdOf } from '@/lib/workflow/types';
import { formatDateTime, shortRef } from '@/lib/format';

export default function RunsPage() {
  const { runs, ready } = useRunStore();
  const [filter, setFilter] = React.useState<'all' | 'complete' | 'failed'>('all');
  const completedCount = runs.filter((r) => r.status === 'complete').length;
  const failedCount = runs.filter((r) => r.status === 'failed').length;
  const filtered = runs.filter((r) => filter === 'all' || r.status === filter);

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <PageHeader
            eyebrow="Autonomous"
            title="Runs"
            description="Every autonomous procurement mission executed from this browser. Runs persist for this tab session; order history always reloads from the backend."
            actions={
              <Link href="/">
                <Button size="sm">
                  <Plus className="h-4 w-4" aria-hidden />
                  New mission
                </Button>
              </Link>
            }
          />

          {!ready && <LoadingState title="Loading runs" />}

          {ready && runs.length === 0 && (
            <EmptyState
              title="No runs yet"
              description="Send a request from the command center and Relay will execute the full 13-stage mission here."
              actionLabel="Go to command center"
              onAction={() => (window.location.href = '/')}
            />
          )}

          {ready && runs.length > 0 && (
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter runs by status">
              {(
                [
                  { value: 'all', label: `All · ${runs.length}` },
                  { value: 'complete', label: `Completed · ${completedCount}` },
                  { value: 'failed', label: `Failed · ${failedCount}` },
                ] as const
              ).map((chip) => (
                <button
                  key={chip.value}
                  type="button"
                  onClick={() => setFilter(chip.value)}
                  aria-pressed={filter === chip.value}
                  className={
                    filter === chip.value
                      ? 'rounded-md bg-relay-navy-900 px-3 py-1.5 text-[12.5px] font-semibold text-white min-h-[34px]'
                      : 'rounded-md border border-relay-surface-border bg-white px-3 py-1.5 text-[12.5px] font-semibold text-relay-ink-700 hover:bg-relay-surface-sunken min-h-[34px]'
                  }
                >
                  {chip.label}
                </button>
              ))}
            </div>
          )}

          {ready && runs.length > 0 && filtered.length === 0 && (
            <EmptyState
              title={filter === 'failed' ? 'No failed runs' : 'No completed runs'}
              description={
                filter === 'failed'
                  ? 'Every recorded mission in this tab completed. Failed missions would appear here with their halted stage.'
                  : 'No completed mission in this tab session yet.'
              }
            />
          )}

          {ready && filtered.length > 0 && (
            <ul className="space-y-3">
              {filtered.map((run) => {
                const id = runIdOf(run)!;
                const stages = mapRunToStages(run);
                const verified = stages.filter((s) => s.state === 'verified').length;
                const failed = stages.filter((s) => s.state === 'failed').length;
                return (
                  <li key={id}>
                    <Link href={`/runs/${id}`} className="block group">
                      <Card className="px-5 sm:px-6 py-5 group-hover:border-relay-primary-500/50 group-hover:shadow-raised transition-all">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3 min-w-0">
                            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-relay-navy-900 text-white shrink-0">
                              <Radar className="h-5 w-5" aria-hidden />
                            </span>
                            <div className="min-w-0">
                              <p className="text-[15px] font-semibold text-relay-ink-900 tracking-tight line-clamp-2">
                                “{run.prompt}”
                              </p>
                              <p className="text-xs text-relay-ink-500 font-mono mt-1">
                                {shortRef(id, 'RUN-')} · {formatDateTime(run.finishedAt)}
                              </p>
                            </div>
                          </div>
                          <ArrowRight className="h-4 w-4 text-relay-ink-400 shrink-0 mt-1 group-hover:text-relay-primary-600 group-hover:translate-x-0.5 transition-all" aria-hidden />
                        </div>
                        <div className="flex flex-wrap items-center gap-2 mt-4">
                          {run.status === 'failed' ? (
                            <Badge variant="error">Could not complete</Badge>
                          ) : failed > 0 ? (
                            <Badge variant="warning">{failed} stages need attention</Badge>
                          ) : (
                            <Badge variant="success">Mission complete</Badge>
                          )}
                          <span className="text-xs text-relay-ink-600 tnum">
                            {verified}/13 stages verified
                          </span>
                          <span className="flex-1" aria-hidden />
                          <span className="flex gap-[3px]" aria-hidden>
                            {stages.map((s) => (
                              <span
                                key={s.stage}
                                className={`h-1.5 w-4 rounded-full ${
                                  s.state === 'verified'
                                    ? 'bg-relay-success-500'
                                    : s.state === 'failed'
                                      ? 'bg-relay-danger-500'
                                      : 'bg-relay-surface-border'
                                }`}
                              />
                            ))}
                          </span>
                        </div>
                      </Card>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Container>
    </div>
  );
}
