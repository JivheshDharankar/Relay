'use client';

import React, { useCallback, useState } from 'react';
import { PackageCheck, RefreshCw } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ApiClientError, getDeliveryStatus } from '@/lib/api';
import type { DeliverySnapshot } from '@/types';
import { formatDateTime } from '@/lib/format';

export const DELIVERY_ORDER = ['PENDING', 'PREPARING', 'DISPATCHED', 'OUT_FOR_DELIVERY', 'DELIVERED'];

/**
 * Maps every status vocabulary that reaches this bar onto the delivery
 * progression. DeliverySnapshot uses DELIVERY_ORDER verbatim; workflow
 * fulfillment records use VERIFIED for a completed, delivery-verified
 * fulfillment — previously an unmapped status left the bar empty even for
 * verified missions. Unknown values stay unmapped (-1): an honest empty
 * bar beats a guessed one.
 */
export function deliveryStepIndex(status: string | null | undefined): number {
  if (!status) return -1;
  const s = status.toUpperCase();
  if (DELIVERY_ORDER.includes(s)) return DELIVERY_ORDER.indexOf(s);
  if (s === 'VERIFIED' || s === 'FULFILLED' || s === 'COMPLETED') return 4;
  if (s === 'IN_TRANSIT' || s === 'SHIPPED' || s === 'IN_DELIVERY') return 2;
  if (s === 'CONFIRMED' || s === 'COMMITTED' || s === 'PAID') return 1;
  return -1;
}

export function DeliveryProgress({ status }: { status: string | null }) {
  const stageIndex = deliveryStepIndex(status);
  return (
    <ol className="flex items-center gap-1" aria-label="Delivery progress">
      {DELIVERY_ORDER.map((stage, i) => {
        const reached = stageIndex >= 0 && i <= stageIndex;
        const current = i === stageIndex;
        return (
          <li key={stage} className="flex-1 min-w-0">
            <div
              className={`h-1.5 rounded-full ${reached ? 'bg-relay-success-500' : 'bg-relay-surface-border'}`}
              aria-hidden
            />
            <p
              className={`mt-1.5 text-[10px] sm:text-[11px] leading-tight truncate ${
                current ? 'font-semibold text-relay-ink-900' : 'text-relay-ink-500'
              }`}
              aria-current={current ? 'step' : undefined}
            >
              {stage.replace(/_/g, ' ').toLowerCase()}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Fulfillment card with optional live refresh. Initial values come from the
 * caller (run artifacts or order records); refresh polls the backend snapshot.
 */
export function FulfillmentCard({
  communityOrderId,
  initialStatus,
  initialTracking,
  supplierName,
  poReference,
  confirmedEta,
  title = 'Fulfillment',
  description = 'Live delivery state from the backend · 12-hour hard SLA',
}: {
  communityOrderId: string | null;
  initialStatus: string | null;
  initialTracking: string | null;
  supplierName?: string | null;
  poReference?: string | null;
  confirmedEta?: string | null;
  title?: string;
  description?: string;
}) {
  const [live, setLive] = useState<DeliverySnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const status = live?.status ?? initialStatus;
  const tracking = live?.trackingCode ?? initialTracking;

  const refresh = useCallback(async () => {
    if (!communityOrderId) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      setLive(await getDeliveryStatus(communityOrderId));
    } catch (err) {
      setRefreshError(err instanceof ApiClientError ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }, [communityOrderId]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <PackageCheck className="h-4 w-4 text-relay-primary-600" aria-hidden />
              {title}
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {communityOrderId && (
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing} className="self-start sm:self-auto">
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
              {refreshing ? 'Refreshing…' : 'Refresh status'}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <DeliveryProgress status={status} />
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 border-t border-relay-surface-border pt-4 text-sm">
          <div className="border-b border-relay-surface-border pb-2.5">
            <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">Status</dt>
            <dd className="font-semibold mt-1">{status ?? '—'}</dd>
          </div>
          <div className="border-b border-relay-surface-border pb-2.5">
            <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">Tracking reference</dt>
            <dd className="font-mono text-[13px] mt-1 break-all">{tracking ?? '—'}</dd>
          </div>
          {supplierName && (
            <div className="border-b border-relay-surface-border pb-2.5">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">Supplier</dt>
              <dd className="font-medium mt-1">{supplierName}</dd>
            </div>
          )}
          {poReference && (
            <div className="border-b border-relay-surface-border pb-2.5">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">Supplier PO</dt>
              <dd className="font-mono text-[13px] mt-1">{poReference}</dd>
            </div>
          )}
          {confirmedEta && (
            <div className="border-b border-relay-surface-border pb-2.5">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">Confirmed ETA</dt>
              <dd className="font-medium mt-1">{formatDateTime(confirmedEta)}</dd>
            </div>
          )}
          {live?.deliveredAt && (
            <div className="border-b border-relay-surface-border pb-2.5">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">Delivered at</dt>
              <dd className="font-medium mt-1">{formatDateTime(live.deliveredAt)}</dd>
            </div>
          )}
        </dl>
        {refreshError && (
          <p className="text-xs text-relay-danger-700" role="alert">
            {refreshError} — showing last verified state.
          </p>
        )}
        {live && (
          <p className="text-[11px] text-relay-ink-500">
            Last refreshed {formatDateTime(live.updatedAt)} from execution/delivery.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
