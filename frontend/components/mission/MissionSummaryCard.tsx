'use client';

import React from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  ArrowRight,
  CornerDownLeft,
  ShoppingBag,
  FileCheck2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ProcurementProofDisplay } from './ProcurementProofDisplay';
import { formatMoney } from '@/lib/format';
import type { ReconEvidence } from '@/lib/workflow/runEvidence';

interface MissionSummaryCardProps {
  prompt: string;
  runId: string;
  residentOrderId: string | null;
  communityOrderId: string | null;
  itemsDisplay: Array<{ name: string; quantity: number | string | null; unit?: string }>;
  winningSupplier: string;
  totalAmount: number | string | null;
  currency?: string;
  slaHours: number | string | null;
  requestedDeadlineHours?: number | null;
  operationalSlaHours?: number | null;
  reconEvidence: ReconEvidence | null;
  verifiedStages?: number;
  totalStages?: number;
  onReturnToCommandCenter: () => void;
}

export function MissionSummaryCard({
  prompt,
  runId,
  residentOrderId,
  communityOrderId,
  itemsDisplay,
  winningSupplier,
  totalAmount,
  currency = 'INR',
  slaHours,
  requestedDeadlineHours = null,
  operationalSlaHours = null,
  reconEvidence,
  verifiedStages,
  totalStages = 13,
  onReturnToCommandCenter,
}: MissionSummaryCardProps) {
  const parsedTotal =
    typeof totalAmount === 'string' ? parseFloat(totalAmount) : totalAmount;
  const hasTotal =
    parsedTotal !== null && parsedTotal !== undefined && !Number.isNaN(parsedTotal);
  const formattedTotal = hasTotal ? formatMoney(parsedTotal as number, currency) : '—';
  const hasSupplier = winningSupplier !== '' && winningSupplier !== '—';
  const hasSla = slaHours !== null && slaHours !== undefined && slaHours !== '';

  // Conclusion checks: each row renders only when backend evidence proves it.
  const fullVerified = (verifiedStages ?? 0) >= totalStages;
  const conclusionChecks = [
    { label: 'Supplier verified', ok: hasSupplier },
    { label: 'Quote validated', ok: hasTotal },
    { label: 'Payment authorized', ok: reconEvidence?.paymentPassed === true },
    { label: 'Fulfillment verified', ok: fullVerified },
    {
      label: 'Allocation reconciled',
      ok: reconEvidence?.isReconciled === true && reconEvidence?.financial?.passed === true,
    },
  ].filter((c) => c.ok);

  // Large proof figures: backend pillar strings only (never computed here).
  const proofPillars = reconEvidence?.pillars ?? [];
  const proofFigures =
    proofPillars.length >= 4
      ? [
          { label: 'Purchased', value: proofPillars[1]?.value ?? null },
          { label: 'Paid', value: proofPillars[2]?.value ?? null },
          { label: 'Allocated', value: proofPillars[3]?.value ?? null },
        ]
      : [];

  return (
    <div
      className="space-y-4"
      role="region"
      aria-label="Mission Complete Summary"
    >
      {/* Completion statement: what happened, proven, in plain figures. */}
      <section className="rounded-lg border border-relay-surface-border bg-white shadow-card overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 sm:px-6 pt-5 pb-4 border-b border-relay-surface-border">
          <div>
            <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-relay-ink-900">
              Mission Complete
            </h2>
            <p className="text-sm text-relay-ink-600 mt-1">
              “{prompt}”
            </p>
          </div>
          <p className="inline-flex items-center gap-1.5 text-[13px] font-medium text-relay-success-700 pt-1">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            {verifiedStages ?? totalStages} / {totalStages} Stages Verified
          </p>
        </div>

        {/* Outcome rows */}
        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 lg:divide-x divide-relay-surface-border border-b border-relay-surface-border">
          <div className="px-5 sm:px-6 py-4">
            <dt className="text-xs text-relay-ink-500">Procured Items</dt>
            <dd className="mt-1.5 space-y-0.5">
              {itemsDisplay.length > 0 ? (
                itemsDisplay.map((item, i) => (
                  <p key={i} className="text-sm font-medium text-relay-ink-900 truncate">
                    {item.quantity ?? '—'} {item.unit ? `${item.unit} ` : ''}· {item.name}
                  </p>
                ))
              ) : (
                <p className="text-sm font-medium text-relay-ink-500">—</p>
              )}
            </dd>
          </div>
          <div className="px-5 sm:px-6 py-4">
            <dt className="text-xs text-relay-ink-500">Winning Supplier</dt>
            <dd className="mt-1.5">
              <p className="text-[15px] font-semibold text-relay-ink-900 truncate">
                {hasSupplier ? winningSupplier : '—'}
              </p>
              <p className="text-xs text-relay-ink-500 mt-0.5">
                {hasSupplier ? 'Qualified & Verified' : 'Supplier not confirmed'}
              </p>
            </dd>
          </div>
          <div className="px-5 sm:px-6 py-4">
            <dt className="text-xs text-relay-ink-500">Validated Total</dt>
            <dd className="mt-1.5">
              <p className="font-mono text-lg font-semibold text-relay-ink-900 tnum">
                {formattedTotal}
              </p>
              <p className={`text-xs mt-0.5 ${hasTotal ? 'text-relay-success-700' : 'text-relay-ink-500'}`}>
                {hasTotal ? 'Settled Under Mandate' : 'Total not confirmed'}
              </p>
            </dd>
          </div>
          <div className="px-5 sm:px-6 py-4">
            <dt className="text-xs text-relay-ink-500">Fulfillment SLA</dt>
            <dd className="mt-1.5">
              <p className="font-mono text-lg font-semibold text-relay-ink-900 tnum">
                {hasSla ? `${slaHours} Hours` : '—'}
              </p>
              <p className="text-xs text-relay-ink-500 mt-0.5">
                {hasSla ? 'Gate Verified Delivery' : 'SLA not confirmed'}
              </p>
              {requestedDeadlineHours !== null && requestedDeadlineHours !== undefined && (
                <p className="text-[11px] text-relay-ink-500 mt-1 leading-snug">
                  Requested within {requestedDeadlineHours}h · Relay guarantee{' '}
                  {operationalSlaHours ?? 12}h
                  {(operationalSlaHours ?? 12) > requestedDeadlineHours &&
                    ' — fulfilled under the Relay guarantee'}
                </p>
              )}
            </dd>
          </div>
        </dl>

        {/* Conclusion checks (evidenced rows only) */}
        {conclusionChecks.length > 0 && (
          <ul className="px-5 sm:px-6 py-3.5 flex flex-wrap gap-x-5 gap-y-1.5 border-b border-relay-surface-border" aria-label="Verified conclusion">
            {conclusionChecks.map((check) => (
              <li key={check.label} className="inline-flex items-center gap-1.5 text-[13px] text-relay-ink-700">
                <CheckCircle2 className="h-4 w-4 text-relay-success-600 shrink-0" aria-hidden />
                {check.label}
              </li>
            ))}
          </ul>
        )}

        {/* Proof figures: backend values, verbatim */}
        {proofFigures.length > 0 && (
          <div className="px-5 sm:px-6 py-4 flex flex-wrap items-end gap-x-7 gap-y-3 bg-relay-surface-sunken/50">
            {proofFigures.map((fig) => (
              <div key={fig.label}>
                <p className="text-xs text-relay-ink-500">
                  {fig.label}
                </p>
                <p className="font-mono text-lg font-semibold text-relay-ink-900 tnum mt-0.5">
                  {fig.value !== null ? `₹${fig.value}` : 'Not confirmed'}
                </p>
              </div>
            ))}
            <div>
              <p className="text-xs text-relay-success-700 font-medium">
                Discrepancy
              </p>
              <p className="font-mono text-lg font-semibold text-relay-success-700 tnum mt-0.5">
                {reconEvidence?.financial?.difference !== null &&
                reconEvidence?.financial?.difference !== undefined
                  ? `₹${reconEvidence.financial.difference}`
                  : 'Not confirmed'}
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Four-pillar financial conservation */}
      <ProcurementProofDisplay
        evidence={reconEvidence}
        currency={currency}
      />

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <Button
          variant="outline"
          size="md"
          onClick={onReturnToCommandCenter}
          className="flex items-center gap-2"
        >
          <CornerDownLeft className="h-4 w-4" aria-hidden />
          Back to Command Center
        </Button>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] font-medium">
          {runId && (
            <Link
              href={`/runs/${runId}`}
              className="inline-flex items-center gap-1.5 text-relay-ink-700 hover:text-relay-ink-900 min-h-[36px]"
            >
              <FileCheck2 className="h-4 w-4 text-relay-ink-400" aria-hidden />
              View Full Run
            </Link>
          )}

          {residentOrderId && (
            <Link
              href={`/orders/${residentOrderId}`}
              className="inline-flex items-center gap-1.5 text-relay-ink-700 hover:text-relay-ink-900 min-h-[36px]"
            >
              <ShoppingBag className="h-4 w-4 text-relay-ink-400" aria-hidden />
              View Order
            </Link>
          )}

          {(runId || communityOrderId) && (
            <Link
              href={runId ? `/runs/${runId}/reconciliation` : `/reconciliation`}
              className="inline-flex items-center gap-1.5 font-semibold text-relay-primary-700 hover:text-relay-primary-600 min-h-[36px]"
            >
              View Reconciliation
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
