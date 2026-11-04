'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, ClipboardList, Radar, Scale, Wallet, XCircle } from 'lucide-react';
import { ApiClientError, getOrders } from '@/lib/api';
import type { PortalOrder } from '@/types';
import { formatDateTime, formatMoneyCompact } from '@/lib/format';
import { useRunStore } from '@/lib/workflow/runStore';
import { runIdOf } from '@/lib/workflow/types';
import { getReconEvidence } from '@/lib/workflow/runEvidence';
import type { SessionMandate } from '@/lib/session/useResidentContext';

/**
 * Command Center operations strip: recent missions (this tab's verified run
 * history), orders still in progress, and the mandate/reconciliation
 * snapshot. Every figure comes from a live hook or fetch; unavailable data
 * renders as an honest note, never a placeholder number.
 */
export function OperationsOverview({
  mandate,
  paymentsRemaining,
}: {
  mandate: SessionMandate | null;
  paymentsRemaining: number | null;
}) {
  const { runs, ready } = useRunStore();
  const [orders, setOrders] = useState<PortalOrder[] | null>(null);
  const [ordersError, setOrdersError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getOrders()
      .then((list) => {
        if (!cancelled) setOrders(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // 401/403 simply mean no resident session data here; other errors
        // show as unavailable rather than a fabricated zero.
        setOrdersError(!(err instanceof ApiClientError && (err.status === 401 || err.status === 403)));
        setOrders([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const latest = runs[0] ?? null;
  const recon = latest ? getReconEvidence(latest) : null;
  const balanced =
    recon?.isReconciled === true && recon?.financial?.passed === true;
  const differenceDisplay =
    recon?.financial?.difference === '0' ? '0.00' : recon?.financial?.difference;
  const activeOrders = (orders ?? []).filter(
    (o) => o.status !== 'DELIVERED' && o.status !== 'FULFILLED' && o.status !== 'CANCELLED'
  );

  return (
    <section aria-label="Operations overview" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[20px] leading-[28px] font-semibold tracking-tight text-[#E8EAED]">Operations</h2>
        <Link href="/runs" className="inline-flex items-center gap-1 text-[13px] font-semibold text-relay-primary-700 hover:text-relay-primary-600 min-h-[32px]">
          View all runs
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Recent missions */}
        <div className="rounded-2xl border border-[#262C37] bg-[#12161D] px-5 sm:px-6 py-5">
          <p className="flex items-center gap-2 text-xs font-medium text-relay-ink-500">
            <Radar className="h-4 w-4 text-relay-ink-400" aria-hidden />
            Recent missions
          </p>
          {!ready ? (
            <p className="text-sm text-relay-ink-500 mt-2">Loading run history…</p>
          ) : runs.length === 0 ? (
            <p className="text-sm text-relay-ink-600 mt-2 leading-relaxed">
              No missions in this tab session yet. Your first mission will appear here.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {runs.slice(0, 3).map((run) => {
                const id = runIdOf(run);
                const content = (
                  <>
                    <span className="flex items-center gap-1.5 min-w-0">
                      {run.status === 'complete' ? (
                        <CheckCircle2 className="h-4 w-4 text-relay-success-600 shrink-0" aria-hidden />
                      ) : (
                        <XCircle className="h-4 w-4 text-relay-danger-600 shrink-0" aria-hidden />
                      )}
                      <span className="truncate font-medium text-relay-ink-900">{run.prompt}</span>
                    </span>
                    <span className="text-[11px] text-relay-ink-500 font-mono shrink-0">
                      {run.finishedAt ? formatDateTime(run.finishedAt) : '—'}
                    </span>
                  </>
                );
                return (
                  <li key={(id ?? run.prompt) + (run.finishedAt ?? '')}>
                    {id ? (
                      <Link href={`/runs/${id}`} className="flex items-center justify-between gap-2 text-sm hover:bg-relay-surface-sunken rounded-md px-2 py-1.5 -mx-2">
                        {content}
                      </Link>
                    ) : (
                      <span className="flex items-center justify-between gap-2 text-sm px-2 py-1.5 -mx-2">{content}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Orders in progress */}
        <div className="rounded-2xl border border-[#262C37] bg-[#12161D] px-5 sm:px-6 py-5">
          <p className="flex items-center gap-2 text-xs font-medium text-relay-ink-500">
            <ClipboardList className="h-4 w-4 text-relay-ink-400" aria-hidden />
            Orders in progress
          </p>
          {orders === null ? (
            <p className="text-sm text-relay-ink-500 mt-2">Loading orders…</p>
          ) : ordersError ? (
            <p className="text-sm text-relay-ink-600 mt-2">Order data unavailable right now.</p>
          ) : (
            <>
              <p className="font-mono text-[26px] leading-tight font-semibold text-relay-ink-900 tnum mt-1.5">
                {activeOrders.length}
              </p>
              <p className="text-sm text-relay-ink-600 mt-1">
                {activeOrders.length === 0
                  ? 'Nothing awaiting fulfillment.'
                  : `${activeOrders.length === 1 ? 'order' : 'orders'} awaiting fulfillment.`}
              </p>
              <Link href="/orders" className="inline-flex items-center gap-1 text-[13px] font-semibold text-relay-primary-700 hover:text-relay-primary-600 mt-2 min-h-[32px]">
                Open orders
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </>
          )}
        </div>

        {/* Mandate + reconciliation snapshot */}
        <div className="rounded-2xl border border-[#262C37] bg-[#12161D] px-5 sm:px-6 py-5">
          <p className="flex items-center gap-2 text-xs font-medium text-relay-ink-500">
            <Wallet className="h-4 w-4 text-relay-ink-400" aria-hidden />
            Mandate & proof
          </p>
          {mandate ? (
            <dl className="mt-2 space-y-1.5 text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-relay-ink-500">Mandate</dt>
                <dd className="font-mono font-semibold text-relay-ink-900 tnum">
                  {formatMoneyCompact(mandate.maximumAmount, mandate.currency)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-relay-ink-500">Remaining</dt>
                <dd className="font-mono font-semibold text-relay-ink-900 tnum">
                  {paymentsRemaining !== null
                    ? formatMoneyCompact(paymentsRemaining, mandate.currency)
                    : '—'}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-relay-ink-600 mt-2 leading-relaxed">
              No active mandate. Complete onboarding to authorize spending.
            </p>
          )}
          <div className="mt-3 pt-3 border-t border-relay-surface-border flex items-start gap-2">
            <Scale className="h-4 w-4 text-relay-ink-400 shrink-0 mt-0.5" aria-hidden />
            {latest && balanced ? (
              <p className="text-sm text-relay-ink-700">
                Last mission reconciled —{' '}
                <span className="font-mono font-semibold text-relay-success-700">
                  ₹{differenceDisplay ?? '0.00'} discrepancy
                </span>
                .{' '}
                <Link href="/reconciliation" className="font-semibold text-relay-primary-700 hover:text-relay-primary-600">
                  Verify
                </Link>
              </p>
            ) : (
              <p className="text-sm text-relay-ink-600">
                Reconciliation proof appears here after your first completed mission.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
