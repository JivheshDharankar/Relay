'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Truck } from 'lucide-react';
import { Container, PageHeader } from '@/components/ui';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import {
  AuthRequiredState,
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/feedback/Feedback';
import { FulfillmentCard } from '@/components/operations/FulfillmentCard';
import { useSession } from '@/lib/session/SessionContext';
import { useRunStore } from '@/lib/workflow/runStore';
import { getFulfillmentEvidence } from '@/lib/workflow/runEvidence';
import { ApiClientError, getOrders } from '@/lib/api';
import type { PortalOrder } from '@/types';
import { formatDate, shortRef } from '@/lib/format';

export default function TrackingPage() {
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
        setError(err instanceof Error ? err.message : 'Failed to load tracking data');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionStatus, router]);

  const fulfillment = latestRun ? getFulfillmentEvidence(latestRun) : null;
  const trackable = (orders ?? []).filter((o) => o.communityOrder);

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <PageHeader
            eyebrow="Operations"
            title="Tracking"
            description="Fulfillment state for the latest run and every pooled community order."
          />

          {sessionStatus === 'loading' && <LoadingState title="Loading tracking" />}
          {sessionStatus === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}
          {sessionStatus === 'authenticated' && error && (
            <ErrorState title="Tracking unavailable" description={error} onRetry={() => window.location.reload()} />
          )}

          {sessionStatus === 'authenticated' && !error && (
            <>
              {ready && fulfillment && (
                <FulfillmentCard
                  communityOrderId={fulfillment.communityOrderId}
                  initialStatus={fulfillment.status}
                  initialTracking={fulfillment.trackingCode}
                  supplierName={fulfillment.supplierName}
                  poReference={fulfillment.poReference}
                  confirmedEta={fulfillment.confirmedDeliveryEta}
                  title="Latest run fulfillment"
                  description={`“${latestRun!.prompt}”`}
                />
              )}

              {(!ready || !fulfillment) && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Truck className="h-4 w-4 text-relay-primary-600" aria-hidden />
                      Latest run fulfillment
                    </CardTitle>
                    <CardDescription>
                      No fulfillment evidence in this tab session — pooled orders below remain fully trackable.
                    </CardDescription>
                  </CardHeader>
                </Card>
              )}

              <section aria-label="Trackable orders" className="space-y-3">
                <h2 className="text-[15px] font-semibold tracking-tight text-relay-ink-900">
                  Pooled orders
                </h2>
                {orders === null ? (
                  <LoadingState title="Loading orders" />
                ) : trackable.length === 0 ? (
                  <EmptyState
                    title="Nothing to track"
                    description="No pooled community orders yet. New procurements appear here once committed."
                  />
                ) : (
                  <ul className="space-y-2.5">
                    {trackable.map((o) => (
                      <li key={o.id}>
                        <Link href={`/tracking/${o.communityOrder!.id}`} className="block group">
                          <Card className="px-5 py-4 group-hover:border-relay-primary-500/50 group-hover:shadow-raised transition-all">
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-relay-ink-900 truncate">
                                  {o.items[0]?.productName ?? 'Order'}
                                  {o.items.length > 1 && <span className="text-relay-ink-500"> +{o.items.length - 1}</span>}
                                </p>
                                <p className="text-xs text-relay-ink-500 font-mono mt-1">
                                  {shortRef(o.communityOrder!.id, 'COMM-')} · {formatDate(o.requestedAt)}
                                </p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <Badge variant={o.communityOrder!.deliveryStatus === 'DELIVERED' ? 'success' : 'info'}>
                                  {o.communityOrder!.deliveryStatus}
                                </Badge>
                                <ArrowRight className="h-4 w-4 text-relay-ink-400 group-hover:text-relay-primary-600 group-hover:translate-x-0.5 transition-all" aria-hidden />
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
