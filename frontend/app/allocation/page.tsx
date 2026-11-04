'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, PieChart } from 'lucide-react';
import { Container, PageHeader } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import {
  AuthRequiredState,
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/feedback/Feedback';
import { ApiClientError, getOrders } from '@/lib/api';
import type { PortalOrder } from '@/types';
import { useSession } from '@/lib/session/SessionContext';
import { formatDate, shortRef } from '@/lib/format';

export default function AllocationHubPage() {
  const router = useRouter();
  const { status: sessionStatus } = useSession();
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
        setError(err instanceof Error ? err.message : 'Failed to load allocations');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionStatus, router]);

  const allocated = (orders ?? []).filter((o) => o.communityOrder);

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <PageHeader
            eyebrow="Finance"
            title="Allocation"
            description="How community procurements were distributed back to resident orders. Only your own share is ever visible."
          />

          {sessionStatus === 'loading' && <LoadingState title="Loading allocations" />}
          {sessionStatus === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}
          {sessionStatus === 'authenticated' && error && (
            <ErrorState title="Allocations unavailable" description={error} onRetry={() => window.location.reload()} />
          )}
          {sessionStatus === 'authenticated' && !error && orders === null && (
            <LoadingState title="Loading allocations" />
          )}
          {sessionStatus === 'authenticated' && !error && orders !== null && allocated.length === 0 && (
            <EmptyState
              title="No allocations yet"
              description="Allocated community procurements will appear here once runs complete."
            />
          )}

          {sessionStatus === 'authenticated' && !error && allocated.length > 0 && (
            <ul className="space-y-2.5">
              {allocated.map((o) => (
                <li key={o.id}>
                  <Link href={`/allocation/${o.communityOrder!.id}`} className="block group">
                    <Card className="px-5 py-4 group-hover:border-relay-primary-500/50 group-hover:shadow-raised transition-all">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-relay-navy-50 text-relay-primary-600 shrink-0">
                            <PieChart className="h-5 w-5" aria-hidden />
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-relay-ink-900 truncate">
                              {o.communityOrder!.supplierName}
                            </p>
                            <p className="text-xs text-relay-ink-500 font-mono mt-0.5">
                              {shortRef(o.communityOrder!.id, 'COMM-')} · {formatDate(o.requestedAt)}
                            </p>
                          </div>
                        </div>
                        <ArrowRight className="h-4 w-4 text-relay-ink-400 shrink-0 group-hover:text-relay-primary-600 group-hover:translate-x-0.5 transition-all" aria-hidden />
                      </div>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Container>
    </div>
  );
}
