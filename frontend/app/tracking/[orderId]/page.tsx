'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Building2 } from 'lucide-react';
import { Container } from '@/components/ui';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import {
  AuthRequiredState,
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/feedback/Feedback';
import { FulfillmentCard } from '@/components/operations/FulfillmentCard';
import { ApiClientError, getDeliveryStatus, getOrders } from '@/lib/api';
import type { DeliverySnapshot, PortalOrder } from '@/types';
import { useSession } from '@/lib/session/SessionContext';
import { formatMoney, formatQuantity, shortRef } from '@/lib/format';

export default function TrackingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const communityOrderId = params?.orderId as string;

  const [order, setOrder] = useState<PortalOrder | null | undefined>(undefined);
  const [delivery, setDelivery] = useState<DeliverySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionStatus !== 'authenticated' || !communityOrderId) return;
    let cancelled = false;
    Promise.all([
      getOrders().catch(() => null as PortalOrder[] | null),
      getDeliveryStatus(communityOrderId).catch(() => null as DeliverySnapshot | null),
    ])
      .then(([all, snapshot]) => {
        if (cancelled) return;
        if (all === null && snapshot === null) {
          setError('Failed to load tracking data');
          return;
        }
        setOrder(all?.find((o) => o.communityOrder?.id === communityOrderId) ?? null);
        setDelivery(snapshot);
        setError(null);
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
  }, [sessionStatus, communityOrderId, router]);

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-4xl mx-auto">
          <Link
            href="/tracking"
            className="inline-flex items-center gap-1.5 text-[13px] text-relay-ink-600 hover:text-relay-ink-900 font-medium min-h-[32px]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            All tracking
          </Link>

          {sessionStatus === 'loading' && <LoadingState title="Loading tracking" />}
          {sessionStatus === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}
          {sessionStatus === 'authenticated' && error && <ErrorState title="Tracking unavailable" description={error} />}
          {sessionStatus === 'authenticated' && !error && order === undefined && <LoadingState title="Loading tracking" />}
          {sessionStatus === 'authenticated' && !error && order === null && !delivery && (
            <EmptyState
              title="Fulfillment not found"
              description="No delivery record exists for this reference in your history."
              actionLabel="All tracking"
              onAction={() => router.push('/tracking')}
            />
          )}

          {sessionStatus === 'authenticated' && !error && (order || delivery) && (
            <>
              <div>
                <p className="font-mono text-xs font-semibold text-relay-ink-900">
                  {shortRef(communityOrderId, 'COMM-')}
                </p>
                <h1 className="text-2xl font-bold tracking-tight text-relay-ink-900 mt-1">
                  Fulfillment tracking
                </h1>
              </div>

              <FulfillmentCard
                communityOrderId={communityOrderId}
                initialStatus={delivery?.status ?? order?.communityOrder?.deliveryStatus ?? null}
                initialTracking={delivery?.trackingCode ?? order?.communityOrder?.trackingCode ?? null}
                supplierName={order?.communityOrder?.supplierName}
              />

              {order && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-1.5">
                      <Building2 className="h-4 w-4 text-relay-ink-500" aria-hidden />
                      Your order in this batch
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <ul className="space-y-2">
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
                    <div className="mt-3 pt-3 border-t border-relay-surface-border">
                      <Link
                        href={`/orders/${order.id}`}
                        className="text-[13px] font-semibold text-relay-primary-600 hover:underline min-h-[32px] inline-flex items-center"
                      >
                        View full order record
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
