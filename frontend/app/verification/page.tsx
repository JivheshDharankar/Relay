'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, BadgeCheck } from 'lucide-react';
import { DeliveryProgress } from '@/components/operations/FulfillmentCard';
import { Container, PageHeader } from '@/components/ui';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import {
  AuthRequiredState,
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/feedback/Feedback';
import { useSession } from '@/lib/session/SessionContext';
import { useRunStore } from '@/lib/workflow/runStore';
import { getFulfillmentEvidence } from '@/lib/workflow/runEvidence';
import { ApiClientError, getOrders } from '@/lib/api';
import type { PortalOrder } from '@/types';
import { formatDateTime, formatDate, shortRef } from '@/lib/format';

export default function VerificationPage() {
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
        setError(err instanceof Error ? err.message : 'Failed to load verification data');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionStatus, router]);

  const fulfillment = latestRun ? getFulfillmentEvidence(latestRun) : null;
  // Delivery confirmation is its own recorded fact (verification evidence on
  // the fulfillment record) — never inferred from the fulfillment status.
  const confirmationRecorded = Boolean(
    fulfillment?.verifiedAt || fulfillment?.verifiedBy || fulfillment?.verificationEvidenceType
  );
  const verifiedOrders = (orders ?? []).filter((o) => o.communityOrder?.deliveryStatus === 'DELIVERED');

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <PageHeader
            eyebrow="Operations"
            title="Verification"
            description="Fulfillment evidence, confirmed deliveries, and verification state — FULFILL flows into VERIFY."
          />

          {sessionStatus === 'loading' && <LoadingState title="Loading verification" />}
          {sessionStatus === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}
          {sessionStatus === 'authenticated' && error && (
            <ErrorState title="Verification unavailable" description={error} onRetry={() => window.location.reload()} />
          )}

          {sessionStatus === 'authenticated' && !error && (
            <>
              {/* Two distinct facts, never merged: fulfillment reports what the
                  supplier executed; delivery confirmation requires its own
                  recorded evidence. A verified FULFILL does not by itself
                  confirm delivery. */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center justify-between gap-2">
                      <span>Fulfillment</span>
                      <Badge variant={fulfillment?.status ? 'info' : 'neutral'} size="sm">
                        {fulfillment?.status ?? 'no run evidence'}
                      </Badge>
                    </CardTitle>
                    <CardDescription>
                      What the supplier executed against the purchase order.
                    </CardDescription>
                  </CardHeader>
                  {ready && fulfillment ? (
                    <CardContent className="pt-0 space-y-4">
                      <DeliveryProgress status={fulfillment.status} />
                      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                        <div>
                          <dt className="text-xs text-relay-ink-500">Supplier</dt>
                          <dd className="font-medium mt-0.5">{fulfillment.supplierName ?? '—'}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-relay-ink-500">Purchase order</dt>
                          <dd className="font-mono text-[13px] mt-0.5 break-all">{fulfillment.poReference ?? '—'}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-relay-ink-500">Tracking</dt>
                          <dd className="font-mono text-[13px] mt-0.5 break-all">{fulfillment.trackingCode ?? '—'}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-relay-ink-500">Delivered at</dt>
                          <dd className="font-medium mt-0.5">{formatDateTime(fulfillment.deliveredAt)}</dd>
                        </div>
                      </dl>
                    </CardContent>
                  ) : (
                    <CardContent className="pt-0">
                      <p className="text-sm text-relay-ink-600">
                        No fulfillment artifact in this tab session. Confirmed deliveries from order history appear below.
                      </p>
                    </CardContent>
                  )}
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center justify-between gap-2">
                      <span>Delivery confirmation</span>
                      {!ready || !fulfillment ? (
                        <Badge variant="neutral" size="sm">PENDING</Badge>
                      ) : confirmationRecorded ? (
                        <Badge variant="success">VERIFIED</Badge>
                      ) : (
                        <Badge variant="warning">PENDING</Badge>
                      )}
                    </CardTitle>
                    <CardDescription>
                      Recorded confirmation that the delivery itself was verified.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0">
                    {!ready || !fulfillment ? (
                      <p className="text-sm text-relay-ink-600">
                        Awaiting fulfillment evidence before confirmation can be assessed.
                      </p>
                    ) : confirmationRecorded ? (
                      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                        <div>
                          <dt className="text-xs text-relay-ink-500">Method</dt>
                          <dd className="font-medium mt-0.5">{fulfillment?.verificationEvidenceType ?? 'Backend delivery confirmation'}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-relay-ink-500">Verified by</dt>
                          <dd className="font-medium mt-0.5">{fulfillment?.verifiedBy ?? '—'}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-relay-ink-500">Verified at</dt>
                          <dd className="font-medium mt-0.5">{formatDateTime(fulfillment?.verifiedAt)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-relay-ink-500">Evidence basis</dt>
                          <dd className="mt-0.5">
                            {fulfillment?.verificationSimulated ? (
                              <Badge variant="warning" size="sm">Simulated verification</Badge>
                            ) : (
                              <span className="font-medium">Backend record</span>
                            )}
                          </dd>
                        </div>
                      </dl>
                    ) : (
                      <p className="text-sm text-relay-ink-600 leading-relaxed">
                        No delivery confirmation recorded yet. Fulfillment completion alone does
                        not confirm delivery — confirmation appears here when the backend records it.
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>

              <section aria-label="Confirmed deliveries" className="space-y-3">
                <h2 className="text-[15px] font-semibold tracking-tight text-relay-ink-900 flex items-center gap-2">
                  <BadgeCheck className="h-4 w-4 text-relay-success-600" aria-hidden />
                  Confirmed deliveries
                </h2>
                {orders === null ? (
                  <LoadingState title="Loading deliveries" />
                ) : verifiedOrders.length === 0 ? (
                  <EmptyState
                    title="No confirmed deliveries"
                    description="Delivered community orders will be listed here with their tracking evidence."
                  />
                ) : (
                  <ul className="space-y-2.5">
                    {verifiedOrders.map((o) => (
                      <li key={o.id}>
                        <Link href={`/tracking/${o.communityOrder!.id}`} className="block group">
                          <Card className="px-5 py-4 group-hover:border-relay-success-600/40 group-hover:shadow-raised transition-all">
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-relay-ink-900 truncate">
                                  {o.items[0]?.productName ?? 'Order'}
                                </p>
                                <p className="text-xs text-relay-ink-500 font-mono mt-1">
                                  {o.communityOrder!.trackingCode ?? shortRef(o.communityOrder!.id, 'COMM-')} · {formatDate(o.requestedAt)}
                                </p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <Badge variant="success">Delivered</Badge>
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
