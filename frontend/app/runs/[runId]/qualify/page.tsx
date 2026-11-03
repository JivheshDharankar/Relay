'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle2, XCircle, ShieldCheck } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/feedback/Feedback';
import { StageDetailShell } from '@/components/runs/StageDetailShell';
import { getSupplierEvidence } from '@/lib/workflow/runEvidence';

export default function QualifyStagePage() {
  const params = useParams();
  const runId = params?.runId as string;

  return (
    <StageDetailShell
      runId={runId}
      slug="qualify"
      eyebrow="Stage 03 · Qualify"
      description="How each discovered candidate fared against capability, SLA, radius, and reliability gates."
    >
      {(run) => {
        const evidence = getSupplierEvidence(run);
        if (!evidence) {
          return (
            <EmptyState
              title="No qualification evidence"
              description="This run returned no supplier qualification artifact from the backend."
            />
          );
        }
        const qualified = evidence.suppliers.filter((s) => s.eligible === true);
        const rejected = evidence.suppliers.filter((s) => s.eligible === false);
        const unknown = evidence.suppliers.filter((s) => s.eligible === null);
        return (
          <div className="space-y-4">
            <Card className="border-relay-primary-100">
              <CardContent className="pt-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  <div className="flex gap-2.5">
                    <ShieldCheck className="h-4 w-4 text-relay-ink-400 shrink-0 mt-0.5" aria-hidden />
                    <p className="text-relay-ink-700 leading-relaxed">
                      <strong className="font-semibold text-relay-ink-900">Meta reasons</strong> about
                      candidates — distance, SLA horizons, capability signals.
                    </p>
                  </div>
                  <div className="flex gap-2.5">
                    <ShieldCheck className="h-4 w-4 text-relay-success-600 shrink-0 mt-0.5" aria-hidden />
                    <p className="text-relay-ink-700 leading-relaxed">
                      <strong className="font-semibold text-relay-ink-900">Relay&apos;s deterministic validator</strong> decides
                      eligibility. Only validated suppliers can receive quotes.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm">Qualified</CardTitle>
                    <Badge variant="success">{qualified.length}</Badge>
                  </div>
                  <CardDescription>Passed every hard gate.</CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  {qualified.length === 0 ? (
                    <p className="text-sm text-relay-ink-600">No supplier qualified on this run.</p>
                  ) : (
                    <ul className="space-y-2.5">
                      {qualified.map((s) => (
                        <li key={s.supplierId ?? s.supplierName} className="flex items-start gap-2.5 text-sm">
                          <CheckCircle2 className="h-4 w-4 text-relay-success-600 shrink-0 mt-0.5" aria-hidden />
                          <div>
                            <p className="font-semibold text-relay-ink-900">{s.supplierName}</p>
                            <p className="text-xs text-relay-ink-600 tnum mt-0.5">
                              {s.distanceKm !== null && <span>{s.distanceKm} km · </span>}
                              {s.deliverySlaHours !== null && <span>{s.deliverySlaHours}h SLA</span>}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm">Rejected</CardTitle>
                    <Badge variant="error">{rejected.length}</Badge>
                  </div>
                  <CardDescription>Blocked by at least one hard gate.</CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  {rejected.length === 0 ? (
                    <p className="text-sm text-relay-ink-600">No rejections on this run.</p>
                  ) : (
                    <ul className="space-y-3">
                      {rejected.map((s) => (
                        <li key={s.supplierId ?? s.supplierName} className="flex items-start gap-2.5 text-sm">
                          <XCircle className="h-4 w-4 text-relay-danger-600 shrink-0 mt-0.5" aria-hidden />
                          <div className="min-w-0">
                            <p className="font-semibold text-relay-ink-900">{s.supplierName}</p>
                            {s.reasons.map((reason) => (
                              <p key={reason} className="text-xs font-mono text-relay-danger-700 break-words mt-1">
                                {reason}
                              </p>
                            ))}
                            {s.reasons.length === 0 && (
                              <p className="text-xs text-relay-ink-600 mt-1">Did not meet constraints.</p>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>

            {unknown.length > 0 && (
              <p className="text-xs text-relay-ink-500">
                {unknown.length} candidate{unknown.length === 1 ? '' : 's'} arrived without an eligibility verdict and {unknown.length === 1 ? 'is' : 'are'} excluded from quoting.
              </p>
            )}
          </div>
        );
      }}
    </StageDetailShell>
  );
}
