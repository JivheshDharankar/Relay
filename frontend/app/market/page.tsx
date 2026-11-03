'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Store, Radar, GitCompareArrows, Handshake, Trophy } from 'lucide-react';
import { Container, PageHeader } from '@/components/ui';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { ErrorState, LoadingState } from '@/components/feedback/Feedback';
import { useRunStore } from '@/lib/workflow/runStore';
import {
  getNegotiationEvidence,
  getQuoteEvidence,
  getSupplierEvidence,
} from '@/lib/workflow/runEvidence';
import { runIdOf } from '@/lib/workflow/types';
import { getSuppliers } from '@/lib/api';
import type { VerifiedSupplier } from '@/types';
import { formatMoney } from '@/lib/format';

export default function MarketPage() {
  const { latestRun, ready } = useRunStore();
  const [catalog, setCatalog] = useState<VerifiedSupplier[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSuppliers()
      .then((data) => {
        if (!cancelled) {
          setCatalog(data);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load market data');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runId = latestRun ? runIdOf(latestRun) : null;
  const suppliers = latestRun ? getSupplierEvidence(latestRun) : null;
  const quotes = latestRun ? getQuoteEvidence(latestRun) : null;
  const negotiation = latestRun ? getNegotiationEvidence(latestRun) : null;
  const winner = quotes?.offers.find((o) => o.selected) ?? null;

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <PageHeader
            eyebrow="Procurement"
            title="Market"
            description="Procurement intelligence — what Relay discovered, qualified, quoted, and negotiated on the latest run, plus the verified community catalog."
          />

          {error && <ErrorState title="Market unavailable" description={error} onRetry={() => window.location.reload()} />}

          {/* Latest-run intelligence — deep-navy feature panel */}
          <section className="relative overflow-hidden rounded-xl bg-relay-navy-950 text-white shadow-hero px-5 py-5 sm:px-6" aria-label="Latest run intelligence">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-relay-teal-500" aria-hidden />
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-[15px] font-semibold tracking-tight flex items-center gap-2">
                  <Radar className="h-4 w-4 text-relay-teal-500" aria-hidden />
                  Latest run intelligence
                </h2>
                <p className="text-xs text-relay-navy-200 mt-1">
                  {latestRun ? `“${latestRun.prompt}”` : 'No run in this tab session yet.'}
                </p>
              </div>
              {runId && (
                <Link
                  href={`/runs/${runId}`}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-white hover:text-relay-teal-100 min-h-[32px]"
                >
                  Open run
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              )}
            </div>
            {ready && latestRun && (
              <>
                <dl className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4 mt-4">
                  <div>
                    <dt className="text-xs text-relay-navy-200">Qualified</dt>
                    <dd className="font-mono text-[22px] leading-tight font-semibold tnum mt-1">
                      {suppliers?.qualifiedCount ?? '—'}
                      <span className="text-sm font-medium text-relay-navy-200">/{suppliers?.eligibleCount ?? '—'}</span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-relay-navy-200">Quotes</dt>
                    <dd className="font-mono text-[22px] leading-tight font-semibold tnum mt-1">{quotes?.offers.length ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-relay-navy-200">Negotiation</dt>
                    <dd className="font-mono text-[22px] leading-tight font-semibold tnum mt-1">
                      {negotiation ? `${negotiation.rounds.length} steps` : 'No round'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-relay-navy-200">Winner</dt>
                    <dd className="mt-1">
                      <p className="text-sm font-semibold truncate">
                        {winner ? winner.supplierName : '—'}
                      </p>
                      {winner?.totalPrice !== null && winner?.totalPrice !== undefined && (
                        <p className="font-mono text-xs text-relay-teal-500 tnum">{formatMoney(winner.totalPrice)}</p>
                      )}
                    </dd>
                  </div>
                </dl>
                {runId && (
                  <div className="flex flex-wrap gap-x-5 gap-y-1.5 mt-4 pt-3 border-t border-white/10 text-[13px] font-medium">
                    <Link href={`/runs/${runId}/discover`} className="text-relay-navy-100 hover:text-white inline-flex items-center gap-1 min-h-[32px]">
                      <Radar className="h-3.5 w-3.5 text-relay-teal-500" aria-hidden /> Discovery
                    </Link>
                    <Link href="/quotes" className="text-relay-navy-100 hover:text-white inline-flex items-center gap-1 min-h-[32px]">
                      <GitCompareArrows className="h-3.5 w-3.5 text-relay-teal-500" aria-hidden /> Quotes
                    </Link>
                    <Link href={`/runs/${runId}/negotiation`} className="text-relay-navy-100 hover:text-white inline-flex items-center gap-1 min-h-[32px]">
                      <Handshake className="h-3.5 w-3.5 text-relay-teal-500" aria-hidden /> Negotiation
                    </Link>
                    <Link href={`/runs/${runId}/selection`} className="text-relay-navy-100 hover:text-white inline-flex items-center gap-1 min-h-[32px]">
                      <Trophy className="h-3.5 w-3.5 text-relay-teal-500" aria-hidden /> Selection
                    </Link>
                  </div>
                )}
              </>
            )}
          </section>

          {/* Catalog */}
          <section aria-label="Verified catalog" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[15px] font-semibold tracking-tight text-relay-ink-900 flex items-center gap-2">
                <Store className="h-4 w-4 text-relay-ink-400" aria-hidden />
                Verified catalog
              </h2>
              <Link
                href="/suppliers"
                className="inline-flex items-center gap-1 text-xs font-semibold text-relay-primary-600 hover:text-relay-primary-700 min-h-[32px]"
              >
                All suppliers
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
            {!catalog && !error && <LoadingState title="Loading catalog" />}
            {catalog && catalog.length === 0 && (
              <p className="text-sm text-relay-ink-600">The backend returned no verified suppliers.</p>
            )}
            {catalog && catalog.length > 0 && (
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {catalog.slice(0, 4).map((s) => (
                  <li key={s.id}>
                    <Link href={`/market/suppliers/${s.id}`} className="block group">
                      <Card className="px-4 py-4 group-hover:border-relay-primary-500/50 group-hover:shadow-raised transition-all h-full">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-relay-ink-900 tracking-tight truncate">
                              {s.name}
                            </h3>
                            <p className="text-xs text-relay-ink-600 tnum mt-1">
                              {s.city} · {s.slaHours}h SLA · {s.reliabilityScorePct}% reliability
                            </p>
                          </div>
                          <ArrowRight className="h-4 w-4 text-relay-ink-400 shrink-0 mt-0.5 group-hover:text-relay-primary-600 group-hover:translate-x-0.5 transition-all" aria-hidden />
                        </div>
                      </Card>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {catalog && catalog.length > 4 && (
              <p className="text-xs text-relay-ink-500">+{catalog.length - 4} more in the supplier directory.</p>
            )}
          </section>

          <p className="text-xs text-relay-ink-500 leading-relaxed flex items-center gap-2">
            <Badge variant="neutral" size="sm">No fabricated ratings</Badge>
            Supplier facts come from backend records only.
          </p>
        </div>
      </Container>
    </div>
  );
}
