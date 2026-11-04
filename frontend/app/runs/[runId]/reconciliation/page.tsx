'use client';

import React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowRight, ArrowDown } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/feedback/Feedback';
import { StageDetailShell } from '@/components/runs/StageDetailShell';
import { ReconPillars } from '@/components/finance/ReconPillars';
import { getReconEvidence } from '@/lib/workflow/runEvidence';

export default function ReconciliationStagePage() {
  const params = useParams();
  const runId = params?.runId as string;

  return (
    <StageDetailShell
      runId={runId}
      slug="reconciliation"
      eyebrow="Stage 12 · Reconcile"
      description="Four-pillar money and quantity conservation — the financial proof of this run."
    >
      {(run) => {
        const evidence = getReconEvidence(run);
        if (!evidence) {
          return (
            <EmptyState
              title="No reconciliation evidence"
              description="This run returned no reconciliation artifact from the backend."
            />
          );
        }
        return (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Conservation flow</CardTitle>
                <CardDescription>Each pillar must equal the next — exactly.</CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <ol className="space-y-1 max-w-md">
                  {['Community demand', 'Supplier PO', 'Payment provider', 'Resident allocation'].map(
                    (label, i, arr) => (
                      <li key={label}>
                        <div className="rounded-2xl border border-relay-surface-border bg-relay-navy-50/60 px-4 py-2.5 text-sm font-semibold text-relay-ink-900 text-center">
                          {label}
                        </div>
                        {i < arr.length - 1 && (
                          <div className="flex justify-center py-1" aria-hidden>
                            <ArrowDown className="h-4 w-4 text-relay-success-600" />
                          </div>
                        )}
                      </li>
                    )
                  )}
                </ol>
              </CardContent>
            </Card>

            <ReconPillars evidence={evidence} />

            <Link
              href="/reconciliation"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-relay-primary-600 hover:text-relay-primary-700 min-h-[32px]"
            >
              Open Reconciliation workspace
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        );
      }}
    </StageDetailShell>
  );
}
