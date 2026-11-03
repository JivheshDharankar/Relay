'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { ArrowLeft, Store, Radar } from 'lucide-react';
import { Container } from '@/components/ui';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/feedback/Feedback';
import { useRunStore } from '@/lib/workflow/runStore';
import { getQuoteEvidence, getSupplierEvidence } from '@/lib/workflow/runEvidence';
import { getSuppliers } from '@/lib/api';
import type { VerifiedSupplier } from '@/types';
import { formatMoney, formatRating } from '@/lib/format';

function SupplierDetailInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const supplierId = params?.supplierId as string;
  const runParam = searchParams.get('run');

  const [supplier, setSupplier] = useState<VerifiedSupplier | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const { getRun, latestRun, ready } = useRunStore();

  useEffect(() => {
    let cancelled = false;
    getSuppliers()
      .then((all) => {
        if (!cancelled) {
          setSupplier(all.find((s) => s.id === supplierId) ?? null);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load supplier');
      });
    return () => {
      cancelled = true;
    };
  }, [supplierId]);

  const run = runParam && ready ? getRun(runParam) : (ready ? latestRun : null);
  const discovered = run ? getSupplierEvidence(run)?.suppliers.find((s) => s.supplierId === supplierId) : null;
  const quote = run ? getQuoteEvidence(run)?.offers.find((o) => o.supplierId === supplierId) : null;

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-4xl mx-auto">
          <Link
            href="/suppliers"
            className="inline-flex items-center gap-1.5 text-[13px] text-relay-ink-600 hover:text-relay-ink-900 font-medium min-h-[32px]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            All suppliers
          </Link>

          {error && <ErrorState title="Supplier unavailable" description={error} />}
          {supplier === undefined && !error && <LoadingState title="Loading supplier" />}
          {supplier === null && !error && (
            <EmptyState
              title="Supplier not found"
              description="No verified supplier with this reference exists in the backend catalog."
              actionLabel="All suppliers"
              onAction={() => (window.location.href = '/suppliers')}
            />
          )}

          {supplier && (
            <>
              <div className="flex items-start gap-4">
                <span className="flex h-11 w-11 items-center justify-center rounded-md bg-relay-navy-900 text-white shrink-0">
                  <Store className="h-5 w-5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-relay-ink-900">
                    {supplier.name}
                  </h1>
                  <p className="text-sm text-relay-ink-600 mt-1 tnum">
                    {supplier.city} · ★ {formatRating(supplier.rating)} · {supplier.reliabilityScorePct}% reliability
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-2.5">
                    <Badge variant="info" size="sm">{supplier.slaHours}h SLA</Badge>
                    <Badge variant="neutral" size="sm">{supplier.serviceRadiusKm} km radius</Badge>
                    <Badge variant="success" size="sm">Verified</Badge>
                  </div>
                </div>
              </div>

              {run && (discovered || quote) && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Radar className="h-4 w-4 text-relay-ink-400" aria-hidden />
                      This run&apos;s assessment
                    </CardTitle>
                    <CardDescription>
                      “{run.prompt}”
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div>
                        <dt className="text-xs text-relay-ink-500">Eligibility</dt>
                        <dd className="font-semibold mt-0.5">
                          {discovered?.eligible === true ? 'Qualified' : discovered?.eligible === false ? 'Excluded' : '—'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-relay-ink-500">Distance</dt>
                        <dd className="font-mono font-semibold tnum mt-0.5">
                          {discovered?.distanceKm !== null && discovered?.distanceKm !== undefined ? `${discovered.distanceKm} km` : '—'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-relay-ink-500">Quoted total</dt>
                        <dd className="font-mono font-semibold tnum mt-0.5">
                          {quote?.totalPrice !== null && quote?.totalPrice !== undefined ? formatMoney(quote.totalPrice) : '—'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-relay-ink-500">Outcome</dt>
                        <dd className="font-semibold mt-0.5">
                          {quote?.selected ? 'Selected' : quote ? 'Outranked' : '—'}
                        </dd>
                      </div>
                    </dl>
                    {discovered && discovered.reasons.length > 0 && (
                      <ul className="mt-3 space-y-1 border-t border-relay-surface-border pt-3">
                        {discovered.reasons.map((reason) => (
                          <li key={reason} className="text-xs font-mono text-relay-ink-600 break-words">
                            {reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Listed catalog</CardTitle>
                  <CardDescription>
                    Base prices and MOQs exactly as listed. Quoted procurement totals may differ.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-0 px-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[480px]">
                      <thead>
                        <tr className="border-b border-relay-surface-border text-left text-[11px] text-relay-ink-500">
                          <th className="px-5 py-3 font-semibold">Product</th>
                          <th className="px-4 py-3 font-semibold">Category</th>
                          <th className="px-4 py-3 font-semibold text-right">Base price</th>
                          <th className="px-5 py-3 font-semibold text-right">MOQ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {supplier.catalog.map((item) => (
                          <tr key={item.productId} className="border-b border-relay-surface-border last:border-0">
                            <td className="px-5 py-3 font-medium text-relay-ink-900">{item.name}</td>
                            <td className="px-4 py-3 text-relay-ink-600">{item.category}</td>
                            <td className="px-4 py-3 text-right font-semibold tnum">
                              {formatMoney(item.basePrice)}/{item.unit}
                            </td>
                            <td className="px-5 py-3 text-right tnum text-relay-ink-700">
                              {item.moq} {item.unit}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}

export default function SupplierDetailPage() {
  return (
    <Suspense fallback={<LoadingState title="Loading supplier" />}>
      <SupplierDetailInner />
    </Suspense>
  );
}
