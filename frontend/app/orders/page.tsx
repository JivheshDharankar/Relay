'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Building2, CreditCard, Package, Plus } from 'lucide-react';
import { Container, PageHeader } from '@/components/ui';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
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
import { formatDate, formatMoney, formatQuantity, shortRef } from '@/lib/format';

type Filter = 'all' | 'active' | 'delivered';

function isDelivered(order: PortalOrder): boolean {
  return (
    order.status === 'DELIVERED' ||
    order.communityOrder?.deliveryStatus === 'DELIVERED' ||
    order.communityOrder?.status === 'DELIVERED'
  );
}

function StatusBadge({ order }: { order: PortalOrder }) {
  if (isDelivered(order)) return <Badge variant="success">Delivered</Badge>;
  if (order.status === 'PAID') return <Badge variant="info">Paid</Badge>;
  if (order.status === 'PENDING') return <Badge variant="warning">Pooled</Badge>;
  if (order.status === 'CANCELLED') return <Badge variant="neutral">Cancelled</Badge>;
  return <Badge variant="neutral">{order.status}</Badge>;
}

export default function OrdersPage() {
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const [orders, setOrders] = useState<PortalOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

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
        setError(err instanceof Error ? err.message : 'Failed to load orders');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionStatus, router]);

  const filtered = (orders ?? []).filter((o) => {
    if (filter === 'delivered') return isDelivered(o);
    if (filter === 'active') return !isDelivered(o) && o.status !== 'CANCELLED';
    return true;
  });

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <PageHeader
            eyebrow="Procurement"
            title="Orders"
            description="Autonomous execution histories. Suppliers never see unit identities."
            actions={
              <Link href="/">
                <Button size="sm">
                  <Plus className="h-4 w-4" aria-hidden />
                  New request
                </Button>
              </Link>
            }
          />

          {sessionStatus === 'loading' && <LoadingState title="Loading orders" />}
          {sessionStatus === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}
          {sessionStatus === 'authenticated' && error && (
            <ErrorState title="Orders unavailable" description={error} onRetry={() => window.location.reload()} />
          )}
          {sessionStatus === 'authenticated' && !error && orders === null && (
            <LoadingState title="Loading orders" />
          )}

          {sessionStatus === 'authenticated' && !error && orders !== null && (
            <>
              <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Order filters">
                {(
                  [
                    { id: 'all', label: `All (${orders.length})` },
                    {
                      id: 'active',
                      label: `Active (${orders.filter((o) => !isDelivered(o) && o.status !== 'CANCELLED').length})`,
                    },
                    { id: 'delivered', label: `Delivered (${orders.filter(isDelivered).length})` },
                  ] as { id: Filter; label: string }[]
                ).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="tab"
                    aria-selected={filter === f.id}
                    onClick={() => setFilter(f.id)}
                    className={`px-3.5 py-2 rounded-2xl text-xs font-semibold transition-colors min-h-[36px] ${
                      filter === f.id
                        ? 'bg-relay-navy-900 text-white'
                        : 'bg-[#12161D] border border-relay-surface-border text-relay-ink-600 hover:bg-relay-navy-50'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {filtered.length === 0 ? (
                <EmptyState
                  title="No orders here"
                  description="Send the first request from the command center to start an autonomous procurement."
                  actionLabel="Go to command center"
                  onAction={() => router.push('/')}
                />
              ) : (
                <ul className="space-y-3">
                  {filtered.map((order) => (
                    <li key={order.id}>
                      <Card className="px-5 sm:px-6 py-5 hover:border-relay-primary-500/50 transition-colors">
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-3 border-b border-relay-surface-border">
                          <div className="flex items-center gap-2 text-xs">
                            <span className="font-mono font-semibold text-relay-ink-900">
                              {shortRef(order.id, 'ORD-')}
                            </span>
                            <span className="text-relay-ink-400" aria-hidden>•</span>
                            <span className="text-relay-ink-600">{formatDate(order.requestedAt)}</span>
                          </div>
                          <StatusBadge order={order} />
                        </div>

                        <ul className="py-3 space-y-2">
                          {order.items.map((item) => (
                            <li key={item.id} className="flex items-center justify-between gap-3 text-sm">
                              <span className="inline-flex items-center gap-2.5 min-w-0">
                                <Package className="h-4 w-4 text-relay-primary-600 shrink-0" aria-hidden />
                                <span className="truncate">
                                  <strong className="font-medium text-relay-ink-900">{item.productName}</strong>{' '}
                                  <span className="text-relay-ink-600 tnum">
                                    · {formatQuantity(item.quantity, item.unit)}
                                  </span>
                                </span>
                              </span>
                              <span className="font-semibold text-relay-ink-900 tnum shrink-0">
                                {formatMoney(item.totalPrice, order.currency)}
                              </span>
                            </li>
                          ))}
                        </ul>

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-relay-surface-border text-xs text-relay-ink-600">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            {order.communityOrder?.supplierName && (
                              <span className="inline-flex items-center gap-1.5">
                                <Building2 className="h-3.5 w-3.5 text-relay-ink-500" aria-hidden />
                                {order.communityOrder.supplierName}
                              </span>
                            )}
                            {order.payment?.providerReference && (
                              <span className="inline-flex items-center gap-1.5 font-mono">
                                <CreditCard className="h-3.5 w-3.5 text-relay-ink-500" aria-hidden />
                                {order.payment.providerReference}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <Link
                              href={`/orders/${order.id}`}
                              className="font-semibold text-relay-primary-600 hover:underline min-h-[32px] inline-flex items-center gap-1"
                            >
                              View record
                              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                            </Link>
                            <span className="text-base font-bold text-relay-ink-900 tnum">
                              {formatMoney(order.totalAmount, order.currency)}
                            </span>
                          </div>
                        </div>
                      </Card>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
