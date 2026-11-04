'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { GitCompareArrows, Trophy } from 'lucide-react';
import { Container, PageHeader } from '@/components/ui';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { EmptyState, LoadingState } from '@/components/feedback/Feedback';
import { QuoteComparison } from '@/components/market/QuoteComparison';
import { useRunStore } from '@/lib/workflow/runStore';
import { getQuoteEvidence } from '@/lib/workflow/runEvidence';
import { runIdOf } from '@/lib/workflow/types';
import { formatDateTime, shortRef } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Shared quotes workspace, rendered by both /quotes (canonical) and the
 * legacy /market/quotes deep link. Reads terminal runs from the run store;
 * shows honest empty states when no backend offers exist.
 */
export function QuotesWorkspace() {
  const { runs, ready } = useRunStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const activeId = selectedId ?? (runs.length > 0 ? runIdOf(runs[0]) : null);
  const activeRun = runs.find((r) => runIdOf(r) === activeId) ?? null;
  const quotes = activeRun ? getQuoteEvidence(activeRun) : null;

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <PageHeader
            eyebrow="Procurement"
            title="Quotes"
            description="Normalized supplier offers across autonomous runs — ranked by the backend, inspected here."
          />

          {!ready && <LoadingState title="Loading quotes" />}

          {ready && runs.length === 0 && (
            <EmptyState
              title="No quotes yet"
              description="Quotes appear here after an autonomous run collects supplier offers."
              actionLabel="Go to command center"
              onAction={() => (window.location.href = '/')}
            />
          )}

          {ready && runs.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 items-start">
              {/* Run picker */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Runs</CardTitle>
                  <CardDescription>Select a run to inspect its quotes.</CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  <ul className="space-y-1.5" role="listbox" aria-label="Runs">
                    {runs.map((run) => {
                      const id = runIdOf(run)!;
                      const active = id === activeId;
                      return (
                        <li key={id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={active}
                            onClick={() => setSelectedId(id)}
                            className={cn(
                              'w-full text-left rounded-2xl border px-3 py-2.5 transition-colors min-h-[44px]',
                              active
                                ? 'border-relay-primary-500 bg-relay-primary-50'
                                : 'border-relay-surface-border hover:border-relay-primary-500/50'
                            )}
                          >
                            <p className="text-[13px] font-semibold text-relay-ink-900 truncate">
                              “{run.prompt}”
                            </p>
                            <p className="text-[11px] font-mono text-relay-ink-500 mt-0.5">
                              {shortRef(id, 'RUN-')} · {formatDateTime(run.finishedAt)}
                            </p>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>

              {/* Comparison */}
              <div className="space-y-4 min-w-0">
                {!activeRun || !quotes ? (
                  <EmptyState
                    title="No quotes on this run"
                    description="The selected run returned no ranked offers from the backend."
                  />
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-[15px] font-semibold tracking-tight text-relay-ink-900 flex items-center gap-2">
                        <GitCompareArrows className="h-4 w-4 text-relay-ink-400" aria-hidden />
                        {quotes.offers.length} normalized offers
                      </h2>
                      {activeId && (
                        <Link
                          href={`/runs/${activeId}/selection`}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-relay-primary-600 hover:text-relay-primary-700 min-h-[32px]"
                        >
                          <Trophy className="h-3.5 w-3.5" aria-hidden />
                          Selection rationale
                        </Link>
                      )}
                    </div>
                    <QuoteComparison
                      evidence={quotes}
                      linkSupplier={(supplierId, name) =>
                        supplierId ? (
                          <Link
                            href={`/market/suppliers/${supplierId}${activeId ? `?run=${encodeURIComponent(activeId)}` : ''}`}
                            className="hover:underline"
                          >
                            {name}
                          </Link>
                        ) : (
                          name
                        )
                      }
                    />
                    {quotes.selectedSupplierName && (
                      <Card className="border-relay-success-100 bg-relay-success-50/50">
                        <CardContent className="pt-4">
                          <p className="text-sm text-relay-ink-700 leading-relaxed">
                            <strong className="font-semibold">Selected: {quotes.selectedSupplierName}.</strong>{' '}
                            Supplier selected under configured constraints — validated total, SLA,
                            and reliability as ranked by the backend.
                          </p>
                        </CardContent>
                      </Card>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </Container>
    </div>
  );
}
