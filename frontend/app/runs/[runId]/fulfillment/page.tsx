'use client';

import React, { useCallback, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PackageCheck, RefreshCw, ArrowRight } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/feedback/Feedback';
import { StageDetailShell, EvidenceFacts } from '@/components/runs/StageDetailShell';
import { getFulfillmentEvidence, type FulfillmentEvidence } from '@/lib/workflow/runEvidence';
import { ApiClientError, getDeliveryStatus } from '@/lib/api';
import type { DeliverySnapshot } from '@/types';
import { formatDateTime } from '@/lib/format';

const DELIVERY_ORDER = ['PENDING', 'PREPARING', 'DISPATCHED', 'OUT_FOR_DELIVERY', 'DELIVERED'];

function FulfillmentBody({ evidence }: { evidence: FulfillmentEvidence }) {
  const [live, setLive] = useState<DeliverySnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const status = live?.status ?? evidence.status;
  // The engine reports post-delivery verification as VERIFIED — the terminal
  // step past DELIVERED, not an unknown state.
  const stageIndex = status
    ? status === 'VERIFIED'
      ? DELIVERY_ORDER.length - 1
      : DELIVERY_ORDER.indexOf(status)
    : -1;

  const refresh = useCallback(async () => {
    if (!evidence.communityOrderId) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      setLive(await getDeliveryStatus(evidence.communityOrderId));
    } catch (err) {
      setRefreshError(err instanceof ApiClientError ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }, [evidence.communityOrderId]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6 space-y-5">
          <ol className="flex items-center gap-1" aria-label="Delivery progress">
            {DELIVERY_ORDER.map((stage, i) => {
              const reached = stageIndex >= 0 && i <= stageIndex;
              const current = i === stageIndex;
              return (
                <li key={stage} className="flex-1 min-w-0">
                  <div className={`h-1.5 rounded-full ${reached ? 'bg-relay-success-500' : 'bg-relay-surface-border'}`} aria-hidden />
                  <p
                    className={`mt-1.5 text-[10px] sm:text-[11px] leading-tight truncate ${current ? 'font-semibold text-relay-ink-900' : 'text-relay-ink-500'}`}
                    aria-current={current ? 'step' : undefined}
                  >
                    {stage.replace(/_/g, ' ').toLowerCase()}
                  </p>
                </li>
              );
            })}
          </ol>
          <div className="border-t border-relay-surface-border pt-4">
            <EvidenceFacts
              facts={[
                { label: 'Status', value: status ?? '—' },
                { label: 'Tracking reference', value: live?.trackingCode ?? evidence.trackingCode ?? '—' },
                { label: 'Supplier', value: evidence.supplierName ?? '—' },
                { label: 'Supplier PO', value: evidence.poReference ?? '—' },
                { label: 'Confirmed ETA', value: formatDateTime(evidence.confirmedDeliveryEta) },
                { label: 'Delivered at', value: formatDateTime(live?.deliveredAt ?? evidence.deliveredAt) },
              ]}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {evidence.communityOrderId && (
              <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
                {refreshing ? 'Refreshing…' : 'Refresh live status'}
              </Button>
            )}
            {live && (
              <p className="text-[11px] text-relay-ink-500">
                Last refreshed {formatDateTime(live.updatedAt)} from execution/delivery.
              </p>
            )}
          </div>
          {refreshError && (
            <p className="text-xs text-relay-danger-700" role="alert">
              {refreshError} — showing last verified state.
            </p>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-relay-ink-500 leading-relaxed">
        Hard SLA is 12 hours from commitment. No maps or GPS are shown — only the
        backend-reported fulfillment state.
      </p>
    </div>
  );
}

export default function FulfillmentStagePage() {
  const params = useParams();
  const runId = params?.runId as string;

  return (
    <StageDetailShell
      runId={runId}
      slug="fulfillment"
      eyebrow="Stage 09 · Fulfill"
      description="Supplier fulfillment underway — operational state reported by the backend."
    >
      {(run) => {
        const evidence = getFulfillmentEvidence(run);
        if (!evidence) {
          return (
            <EmptyState
              title="No fulfillment evidence"
              description="This run returned no fulfillment artifact from the backend."
            />
          );
        }
        return (
          <div className="space-y-4">
            <Card className="bg-relay-navy-900 border-relay-navy-900 text-white">
              <CardHeader>
                <CardTitle className="text-white flex items-center gap-2 text-sm">
                  <PackageCheck className="h-4 w-4 text-relay-primary-500" aria-hidden />
                  Operational tracking
                </CardTitle>
                <CardDescription className="text-relay-navy-200">
                  The same live state powers the Tracking workspace.
                </CardDescription>
              </CardHeader>
            </Card>
            <FulfillmentBody evidence={evidence} />
            <Link
              href="/tracking"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-relay-primary-600 hover:text-relay-primary-700 min-h-[32px]"
            >
              Open Tracking
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        );
      }}
    </StageDetailShell>
  );
}
