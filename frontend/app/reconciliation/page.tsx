'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Scale } from 'lucide-react';
import { Container, PageHeader } from '@/components/ui';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import {
  AuthRequiredState,
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/feedback/Feedback';
import { ReconPillars } from '@/components/finance/ReconPillars';
import { useSession } from '@/lib/session/SessionContext';
import { useRunStore } from '@/lib/workflow/runStore';
import { getReconEvidence } from '@/lib/workflow/runEvidence';
import { ApiClientError, getOrders } from '@/lib/api';
import type { PortalOrder } from '@/types';
import { formatDate, shortRef } from '@/lib/format';

export default function ReconciliationHubPage() {
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const { latestRun, ready } = useRunStore();
  const [orders, setOrders] = useState<PortalOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionStatus !== 'authenticated') return;
    let cancelled = false;
    getOrders()
      .then((data) => {
        if (!cancelled) {
          setOrders(data);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load reconciliation data');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionStatus, router]);

  const runRecon = latestRun ? getReconEvidence(latestRun) : null;
  const reconcilable = (orders ?? []).filter((o) => o.communityOrder);

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-8 max-w-5xl mx-auto">
          <PageHeader
            eyebrow="Finance"
            title="Reconciliation"
            description="Financial conservation proof — every rupee and unit traced from community demand to resident allocation."
          />

          {sessionStatus === 'loading' && <LoadingState title="Loading reconciliation" />}
          {sessionStatus === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}
          {sessionStatus === 'authenticated' && error && (
            <ErrorState title="Reconciliation unavailable" description={error} onRetry={() => window.location.reload()} />
          )}

          {sessionStatus === 'authenticated' && !error && (
            <>
              <section aria-label="Latest run proof" className="space-y-4">
                <h2 className="text-[15px] font-semibold tracking-tight text-relay-ink-900 flex items-center gap-2">
                  <Scale className="h-4 w-4 text-relay-success-600" aria-hidden />
                  Latest run proof
                </h2>
                {!ready ? (
                  <LoadingState title="Loading proof" />
                ) : !latestRun || !runRecon ? (
                  <EmptyState
                    title="No proof yet"
                    description="Run a procurement from the command center — its four-pillar proof renders here."
                    actionLabel="Go to command center"
                    onAction={() => router.push('/')}
                  />
                ) : (
                  <ReconPillars evidence={runRecon} />
                )}
              </section>

              <section aria-label="Order proofs" className="space-y-3">
                <h2 className="text-[15px] font-semibold tracking-tight text-relay-ink-900">
                  Verify an order
                </h2>
                {orders === null ? (
                  <LoadingState title="Loading orders" />
                ) : reconcilable.length === 0 ? (
                  <EmptyState
                    title="No pooled orders"
                    description="Community orders become verifiable here once committed."
                  />
                ) : (
                  <ul className="space-y-2.5">
                    {reconcilable.map((o) => (
                      <li key={o.id}>
                        <Link href={`/reconciliation/${o.communityOrder!.id}`} className="block group">
                          <Card className="px-5 py-4 group-hover:border-relay-success-600/40 group-hover:shadow-raised transition-all">
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-relay-ink-900 truncate">
                                  {o.items[0]?.productName ?? 'Order'}
                                </p>
                                <p className="text-xs text-relay-ink-500 font-mono mt-1">
                                  {shortRef(o.communityOrder!.id, 'COMM-')} · {o.communityOrder!.supplierName} · {formatDate(o.requestedAt)}
                                </p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <Badge variant={o.communityOrder!.status === 'RECONCILED' ? 'success' : 'info'}>
                                  {o.communityOrder!.status}
                                </Badge>
                                <ArrowRight className="h-4 w-4 text-relay-ink-400 group-hover:text-relay-success-600 group-hover:translate-x-0.5 transition-all" aria-hidden />
                              </div>
                            </div>
                          </Card>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
