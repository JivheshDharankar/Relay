'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { Radar, MapPin } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/feedback/Feedback';
import { StageDetailShell } from '@/components/runs/StageDetailShell';
import { getSupplierEvidence } from '@/lib/workflow/runEvidence';
import { cn } from '@/lib/utils';

export default function DiscoverStagePage() {
  const params = useParams();
  const runId = params?.runId as string;

  return (
    <StageDetailShell
      runId={runId}
      slug="discover"
      eyebrow="Stage 02 · Discover"
      description="Commercial suppliers discovered near the community through the backend-configured discovery provider."
    >
      {(run) => {
        const evidence = getSupplierEvidence(run);
        if (!evidence) {
          return (
            <EmptyState
              title="No discovery evidence"
              description="This run returned no supplier discovery artifact from the backend."
            />
          );
        }
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Card>
                <CardContent className="pt-5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">Discovered</p>
                  <p className="text-2xl font-bold tnum mt-1">{evidence.eligibleCount ?? '—'}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">Eligible</p>
                  <p className="text-2xl font-bold tnum mt-1">{evidence.eligibleCount ?? '—'}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">Qualified</p>
                  <p className="text-2xl font-bold tnum mt-1">{evidence.qualifiedCount ?? '—'}</p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Radar className="h-4 w-4 text-relay-primary-600" aria-hidden />
                  Discovery provenance
                </CardTitle>
                <CardDescription>
                  Search area and provider are backend-managed; only returned candidates are shown.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
                  <div className="border-b border-relay-surface-border pb-2.5">
                    <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">Provider</dt>
                    <dd className="font-medium mt-1">Backend-configured discovery</dd>
                  </div>
                  <div className="border-b border-relay-surface-border pb-2.5">
                    <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">Source artifact</dt>
                    <dd className="font-mono text-[13px] mt-1">discoverSuppliers</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {evidence.suppliers.map((s) => (
                <li key={s.supplierId ?? s.supplierName} className="rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-relay-ink-900 tracking-tight truncate">
                        {s.supplierName}
                      </h3>
                      <p className="text-xs text-relay-ink-600 tnum mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        {s.distanceKm !== null && (
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3" aria-hidden />
                            {s.distanceKm} km
                          </span>
                        )}
                        {s.deliverySlaHours !== null && <span>{s.deliverySlaHours}h SLA</span>}
                        {s.serviceRadiusKm !== null && <span>radius {s.serviceRadiusKm} km</span>}
                      </p>
                    </div>
                    {s.eligible !== null && (
                      <Badge variant={s.eligible ? 'success' : 'neutral'} size="sm">
                        {s.eligible ? 'Eligible' : 'Excluded'}
                      </Badge>
                    )}
                  </div>
                  {s.reasons.length > 0 && (
                    <ul className="mt-2.5 space-y-1 border-t border-relay-surface-border pt-2.5">
                      {s.reasons.map((reason) => (
                        <li key={reason} className={cn('text-xs font-mono break-words', s.eligible === false ? 'text-relay-danger-700' : 'text-relay-ink-600')}>
                          {reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      }}
    </StageDetailShell>
  );
}
