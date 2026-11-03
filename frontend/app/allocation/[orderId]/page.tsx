'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, PieChart, Scale, ArrowRight } from 'lucide-react';
import { Container } from '@/components/ui';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import {
  AuthRequiredState,
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/feedback/Feedback';
import { ApiClientError, getOrders } from '@/lib/api';
import type { PortalOrder } from '@/types';
import { useSession } from '@/lib/session/SessionContext';
import { formatMoney, formatQuantity, shortRef } from '@/lib/format';

export default function AllocationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const communityOrderId = params?.orderId as string;

  const [matches, setMatches] = useState<PortalOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionStatus !== 'authenticated' || !communityOrderId) return;
    let cancelled = false;
    getOrders()
      .then((all) => {
        if (!cancelled) {
          setMatches(all.filter((o) => o.communityOrder?.id === communityOrderId));
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load allocation');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionStatus, communityOrderId, router]);

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-4xl mx-auto">
          <Link
            href="/allocation"
            className="inline-flex items-center gap-1.5 text-[13px] text-relay-ink-600 hover:text-relay-ink-900 font-medium min-h-[32px]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            All allocations
          </Link>

          {sessionStatus === 'loading' && <LoadingState title="Loading allocation" />}
          {sessionStatus === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}
          {sessionStatus === 'authenticated' && error && <ErrorState title="Allocation unavailable" description={error} />}
          {sessionStatus === 'authenticated' && !error && matches === null && <LoadingState title="Loading allocation" />}
          {sessionStatus === 'authenticated' && !error && matches !== null && matches.length === 0 && (
            <EmptyState
              title="No allocation found"
              description="None of your orders were allocated from this community order."
              actionLabel="All allocations"
              onAction={() => router.push('/allocation')}
            />
          )}

          {sessionStatus === 'authenticated' && !error && matches !== null && matches.length > 0 && (
            <>
              <div>
                <p className="font-mono text-xs font-semibold text-relay-ink-900">
                  {shortRef(communityOrderId, 'COMM-')}
                </p>
                <h1 className="text-2xl font-bold tracking-tight text-relay-ink-900 mt-1 flex items-center gap-2">
                  <PieChart className="h-6 w-6 text-relay-primary-600" aria-hidden />
                  Your allocation
                </h1>
                <p className="text-sm text-relay-ink-600 mt-1">
                  {matches[0].communityOrder!.supplierName} · status {matches[0].communityOrder!.status}
                </p>
              </div>

              {matches.map((order) => (
                <Card key={order.id}>
                  <CardHeader>
                    <CardTitle className="text-sm font-mono">{shortRef(order.id, 'ORD-')}</CardTitle>
                    <CardDescription>Allocated share · backend-authoritative values.</CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <ul className="space-y-2.5">
                      {order.items.map((item) => (
                        <li key={item.id} className="flex items-center justify-between gap-3 text-sm">
                          <span className="min-w-0">
                            <strong className="font-medium text-relay-ink-900 block truncate">{item.productName}</strong>
                            <span className="text-xs text-relay-ink-600 tnum">
                              {formatQuantity(item.quantity, item.unit)}
                            </span>
                          </span>
                          <span className="font-semibold tnum shrink-0">
                            {formatMoney(item.totalPrice, order.currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="flex items-center justify-between pt-3 mt-3 border-t border-relay-surface-border">
                      <span className="text-sm text-relay-ink-600">Allocated total</span>
                      <span className="text-lg font-bold tnum">{formatMoney(order.totalAmount, order.currency)}</span>
                    </div>
                    <div className="mt-3">
                      <Link
                        href={`/orders/${order.id}`}
                        className="text-[13px] font-semibold text-relay-primary-600 hover:underline min-h-[32px] inline-flex items-center"
                      >
                        View order record
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              ))}

              <div className="rounded-lg border border-relay-surface-border bg-relay-surface-sunken/60 px-5 py-4">
                <p className="text-sm leading-relaxed text-relay-ink-700">
                  Conservation proof: all resident allocations must sum exactly to the
                  committed community total. Other residents&apos; shares stay private —
                  the reconciliation workspace verifies the totals.
                </p>
                <Link
                  href={`/reconciliation/${communityOrderId}`}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-relay-primary-700 hover:text-relay-primary-600 mt-2.5 min-h-[32px]"
                >
                  <Scale className="h-4 w-4" aria-hidden />
                  Verify in reconciliation
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </div>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
