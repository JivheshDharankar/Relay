'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  CreditCard,
  Package,
  ShieldCheck,
  Truck,
  Scale,
  PieChart,
  Radar,
} from 'lucide-react';
import { Container } from '@/components/ui';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import {
  AuthRequiredState,
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/feedback/Feedback';
import { ApiClientError, getDeliveryStatus, getOrders } from '@/lib/api';
import type { DeliverySnapshot, PortalOrder } from '@/types';
import { useSession } from '@/lib/session/SessionContext';
import { formatDateTime, formatMoney, formatQuantity, shortRef } from '@/lib/format';
import { deliveryStepIndex } from '@/components/operations/FulfillmentCard';

function EvidenceLink({ href, icon: Icon, label }: { href: string; icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded-2xl border border-relay-surface-border bg-[#12161D] px-3 py-2 text-[13px] font-semibold text-relay-primary-600 hover:border-relay-primary-500/50 hover:bg-relay-primary-50/50 transition-colors min-h-[40px]"
    >
      <Icon className="h-4 w-4" aria-hidden />
      {label}
    </Link>
  );
}

export default function OrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const orderId = params?.orderId as string;

  const [order, setOrder] = useState<PortalOrder | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<DeliverySnapshot | null>(null);

  useEffect(() => {
    if (sessionStatus !== 'authenticated' || !orderId) return;
    let cancelled = false;
    getOrders()
      .then((all) => {
        if (!cancelled) {
          setOrder(all.find((o) => o.id === orderId) ?? null);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load order');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionStatus, orderId, router]);

  useEffect(() => {
    const communityId = order?.communityOrder?.id;
    if (!communityId) return;
    let cancelled = false;
    getDeliveryStatus(communityId)
      .then((snapshot) => {
        if (!cancelled) setDelivery(snapshot);
      })
      .catch(() => {
        // Delivery snapshot is supplementary; the order record stands alone.
      });
    return () => {
      cancelled = true;
    };
  }, [order?.communityOrder?.id]);

  // Lifecycle steps are recorded facts only: a step is done when its record
  // exists, current when it is the next expected fact, pending otherwise.
  const lifecycle: Array<{ label: string; detail?: string; state: 'done' | 'current' | 'pending' | 'failed' }> =
    order === null || order === undefined
      ? []
      : (() => {
          const deliveryStatus = delivery?.status ?? order.communityOrder?.deliveryStatus ?? null;
          const deliveryIdx = deliveryStepIndex(deliveryStatus);
          const paid =
            order.payment !== null &&
            ['SUCCEEDED', 'SUCCESS', 'PAID', 'COMPLETED'].includes(order.payment.status.toUpperCase());
          const paymentFailed =
            order.payment !== null &&
            ['FAILED', 'FAILURE', 'DECLINED'].includes(order.payment.status.toUpperCase());
          return [
            { label: 'Order placed', detail: formatDateTime(order.requestedAt), state: 'done' as const },
            {
              label: 'Supplier committed',
              detail: order.communityOrder?.supplierName,
              state: order.communityOrder ? ('done' as const) : ('current' as const),
            },
            {
              label: 'Payment',
              detail: order.payment?.status,
              state: paymentFailed
                ? ('failed' as const)
                : paid || order.status === 'PAID' || order.status === 'DELIVERED'
                  ? ('done' as const)
                  : order.communityOrder
                    ? ('current' as const)
                    : ('pending' as const),
            },
            {
              label: 'Fulfillment',
              detail: deliveryStatus ?? undefined,
              state:
                deliveryIdx >= 4
                  ? ('done' as const)
                  : deliveryIdx > 0
                    ? ('current' as const)
                    : paid
                      ? ('current' as const)
                      : ('pending' as const),
            },
            {
              label: 'Delivered',
              detail: delivery?.deliveredAt ? formatDateTime(delivery.deliveredAt) : undefined,
              state:
                deliveryIdx >= 4 || order.status === 'DELIVERED'
                  ? ('done' as const)
                  : deliveryIdx > 0
                    ? ('current' as const)
                    : ('pending' as const),
            },
          ];
        })();

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-4xl mx-auto">
          <Link
            href="/orders"
            className="inline-flex items-center gap-1.5 text-[13px] text-relay-ink-600 hover:text-relay-ink-900 font-medium min-h-[32px]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to orders
          </Link>

          {sessionStatus === 'loading' && <LoadingState title="Loading order" />}
          {sessionStatus === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}
          {sessionStatus === 'authenticated' && error && <ErrorState title="Order unavailable" description={error} />}
          {sessionStatus === 'authenticated' && !error && order === undefined && <LoadingState title="Loading order" />}
          {sessionStatus === 'authenticated' && !error && order === null && (
            <EmptyState
              title="Order not found"
              description="No order with this reference exists in your history. It may belong to another resident."
              actionLabel="Back to orders"
              onAction={() => router.push('/orders')}
            />
          )}

          {sessionStatus === 'authenticated' && !error && order && (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <p className="font-mono text-xs font-semibold text-relay-ink-900">
                    {shortRef(order.id, 'ORD-')}
                  </p>
                  <h1 className="text-2xl font-bold tracking-tight text-relay-ink-900 mt-1">
                    Procurement record
                  </h1>
                  <p className="text-[13px] text-relay-ink-600 mt-0.5">
                    Requested {formatDateTime(order.requestedAt)}
                  </p>
                </div>
                <Badge
                  variant={
                    order.status === 'DELIVERED' ? 'success' : order.status === 'PAID' ? 'info' : order.status === 'PENDING' ? 'warning' : 'neutral'
                  }
                >
                  {order.status}
                </Badge>
              </div>

              {/* Order lifecycle: every step is a recorded fact, in order. */}
              <ol className="flex flex-wrap items-start gap-x-1 gap-y-3 rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none px-5 py-4" aria-label="Order lifecycle">
                {lifecycle.map((step, i) => (
                  <li key={step.label} className="flex items-start gap-1 min-w-[104px] flex-1">
                    <span className="flex flex-col items-center gap-1.5 text-center w-full">
                      <span
                        className={`flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-semibold ${
                          step.state === 'done'
                            ? 'bg-relay-success-600 border-relay-success-600 text-white'
                            : step.state === 'failed'
                              ? 'bg-relay-danger-600 border-relay-danger-600 text-white'
                              : step.state === 'current'
                                ? 'bg-[#12161D] border-relay-teal-600 text-relay-teal-700'
                                : 'bg-[#12161D] border-relay-surface-border text-relay-ink-400'
                        }`}
                        aria-hidden
                      >
                        {step.state === 'done' ? '✓' : i + 1}
                      </span>
                      <span className={`text-[11.5px] leading-tight ${step.state === 'pending' ? 'text-relay-ink-400' : 'font-medium text-relay-ink-900'}`}>
                        {step.label}
                      </span>
                      {step.detail && (
                        <span className="text-[10.5px] text-relay-ink-500 font-mono leading-tight">{step.detail}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>

              {/* Evidence links */}
              <div className="flex flex-wrap gap-2">
                <EvidenceLink href="/runs" icon={Radar} label="Runs" />
                {order.communityOrder && (
                  <>
                    <EvidenceLink href={`/tracking/${order.communityOrder.id}`} icon={Truck} label="Tracking" />
                    <EvidenceLink href={`/allocation/${order.communityOrder.id}`} icon={PieChart} label="Allocation" />
                    <EvidenceLink href={`/reconciliation/${order.communityOrder.id}`} icon={Scale} label="Reconciliation" />
                  </>
                )}
                <EvidenceLink href="/market" icon={Building2} label="Market" />
                <EvidenceLink href="/payments" icon={CreditCard} label="Payments" />
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Items</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <ul className="space-y-2.5">
                    {order.items.map((item) => (
                      <li key={item.id} className="flex items-center justify-between gap-3 text-sm">
                        <span className="inline-flex items-center gap-2.5 min-w-0">
                          <Package className="h-4 w-4 text-relay-primary-600 shrink-0" aria-hidden />
                          <span className="min-w-0">
                            <strong className="font-medium text-relay-ink-900 block truncate">
                              {item.productName}
                            </strong>
                            <span className="text-xs text-relay-ink-600 tnum">
                              {item.category} · {formatQuantity(item.quantity, item.unit)} @{' '}
                              {formatMoney(item.unitPrice, order.currency)}/{item.unit}
                            </span>
                          </span>
                        </span>
                        <span className="font-semibold text-relay-ink-900 tnum shrink-0">
                          {formatMoney(item.totalPrice, order.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex items-center justify-between pt-3 mt-3 border-t border-relay-surface-border">
                    <span className="text-sm text-relay-ink-600">Order total</span>
                    <span className="text-lg font-bold text-relay-ink-900 tnum">
                      {formatMoney(order.totalAmount, order.currency)}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-1.5">
                      <CreditCard className="h-4 w-4 text-relay-ink-500" aria-hidden />
                      Payment
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    {order.payment ? (
                      <dl className="text-[13px] space-y-1.5">
                        <div className="flex justify-between gap-2">
                          <dt className="text-relay-ink-500">Status</dt>
                          <dd className="font-semibold">{order.payment.status}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-relay-ink-500">Amount</dt>
                          <dd className="font-semibold tnum">{formatMoney(order.payment.amount, order.currency)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-relay-ink-500">Reference</dt>
                          <dd className="font-mono text-xs break-all text-right">{order.payment.providerReference ?? '—'}</dd>
                        </div>
                      </dl>
                    ) : (
                      <p className="text-[13px] text-relay-ink-600">No payment recorded for this order yet.</p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-1.5">
                      <Building2 className="h-4 w-4 text-relay-ink-500" aria-hidden />
                      Community order
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    {order.communityOrder ? (
                      <dl className="text-[13px] space-y-1.5">
                        <div className="flex justify-between gap-2">
                          <dt className="text-relay-ink-500">Supplier</dt>
                          <dd className="font-semibold text-right">{order.communityOrder.supplierName}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-relay-ink-500">Status</dt>
                          <dd className="font-semibold">{order.communityOrder.status}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-relay-ink-500">Delivery</dt>
                          <dd className="font-semibold">{delivery?.status ?? order.communityOrder.deliveryStatus}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-relay-ink-500">Tracking</dt>
                          <dd className="font-mono text-xs break-all text-right">
                            {delivery?.trackingCode ?? order.communityOrder.trackingCode ?? '—'}
                          </dd>
                        </div>
                      </dl>
                    ) : (
                      <p className="text-[13px] text-relay-ink-600">Not yet pooled into a community order.</p>
                    )}
                  </CardContent>
                </Card>
              </div>

              <p className="text-xs text-relay-ink-500">Deliver to: {order.deliveryAddress}</p>
              <p className="flex items-start gap-2 text-[13px] text-relay-ink-600 leading-relaxed">
                <ShieldCheck className="h-4 w-4 text-relay-success-600 shrink-0 mt-0.5" aria-hidden />
                This record is visible only to you. Community procurement never exposes
                unit, quantities, or payment details to other residents or suppliers.
              </p>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
