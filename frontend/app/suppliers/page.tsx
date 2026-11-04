'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Store } from 'lucide-react';
import { Container, PageHeader } from '@/components/ui';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/feedback/Feedback';
import { getSuppliers } from '@/lib/api';
import type { VerifiedSupplier } from '@/types';
import { formatMoney, formatRating } from '@/lib/format';

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<VerifiedSupplier[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    getSuppliers()
      .then((data) => {
        if (!cancelled) {
          setSuppliers(data);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load suppliers');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredSuppliers = (suppliers ?? []).filter(
    (s) =>
      normalizedQuery === '' ||
      s.name.toLowerCase().includes(normalizedQuery) ||
      s.city.toLowerCase().includes(normalizedQuery)
  );

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <PageHeader
            eyebrow="Procurement"
            title="Suppliers"
            description="Every verified commercial supplier serving the community — base prices and MOQs exactly as listed by the backend."
          />

          {error && <ErrorState title="Suppliers unavailable" description={error} onRetry={() => window.location.reload()} />}
          {!suppliers && !error && <LoadingState title="Loading suppliers" />}
          {suppliers && suppliers.length === 0 && (
            <EmptyState
              title="No verified suppliers"
              description="The backend returned no verified suppliers for the community."
            />
          )}

          {suppliers && suppliers.length > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="sr-only" htmlFor="supplier-search">Search suppliers</label>
                <input
                  id="supplier-search"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name or city…"
                  className="w-full sm:w-72 rounded-md border border-relay-surface-border bg-[#12161D] px-3.5 py-2.5 text-sm text-relay-ink-900 placeholder:text-relay-ink-400 outline-none focus:border-relay-primary-500 focus:ring-2 focus:ring-relay-primary-500/20 min-h-[42px]"
                />
                <span className="text-xs font-mono text-relay-ink-500">
                  {filteredSuppliers.length} of {suppliers.length}
                </span>
              </div>
              {filteredSuppliers.length === 0 ? (
                <EmptyState
                  title="No suppliers match"
                  description={`No verified supplier matches “${query}”. Try a different name or city.`}
                />
              ) : (
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredSuppliers.map((s) => (
                <li key={s.id}>
                  <Link href={`/market/suppliers/${s.id}`} className="block group h-full">
                    <Card className="px-5 py-5 group-hover:border-relay-primary-500/50 group-hover:shadow-raised transition-all h-full">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 min-w-0">
                          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-relay-navy-900 text-white shrink-0">
                            <Store className="h-5 w-5" aria-hidden />
                          </span>
                          <div className="min-w-0">
                            <h2 className="text-[15px] font-semibold text-relay-ink-900 tracking-tight truncate">
                              {s.name}
                            </h2>
                            <p className="text-xs text-relay-ink-600 tnum mt-0.5">
                              {s.city} · ★ {formatRating(s.rating)} · {s.reliabilityScorePct}% reliability
                            </p>
                          </div>
                        </div>
                        <ArrowRight className="h-4 w-4 text-relay-ink-400 shrink-0 mt-1 group-hover:text-relay-primary-600 group-hover:translate-x-0.5 transition-all" aria-hidden />
                      </div>
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        <Badge variant="info" size="sm">{s.slaHours}h SLA</Badge>
                        <Badge variant="neutral" size="sm">{s.serviceRadiusKm} km radius</Badge>
                        <Badge variant="neutral" size="sm">{s.catalog.length} products</Badge>
                      </div>
                      <dl className="mt-3 space-y-1.5 border-t border-relay-surface-border pt-3">
                        {s.catalog.slice(0, 3).map((item) => (
                          <div key={item.productId} className="flex items-baseline justify-between gap-2 text-[13px]">
                            <dt className="text-relay-ink-700 truncate">
                              {item.name}
                              <span className="text-relay-ink-500"> · MOQ {item.moq} {item.unit}</span>
                            </dt>
                            <dd className="font-semibold text-relay-ink-900 tnum shrink-0">
                              {formatMoney(item.basePrice)}/{item.unit}
                            </dd>
                          </div>
                        ))}
                        {s.catalog.length > 3 && (
                          <p className="text-xs text-relay-ink-500">+{s.catalog.length - 3} more products</p>
                        )}
                      </dl>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
              )}
            </div>
          )}
        </div>
      </Container>
    </div>
  );
}
