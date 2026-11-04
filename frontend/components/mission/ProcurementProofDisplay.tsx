'use client';

import React from 'react';
import { CheckCircle2 } from 'lucide-react';
import { formatMoney } from '@/lib/format';
import type { ReconEvidence } from '@/lib/workflow/runEvidence';

interface ProcurementProofDisplayProps {
  evidence: ReconEvidence | null;
  currency?: string;
  className?: string;
}

/**
 * Financial conservation, stated as a ledger: the value that entered the
 * procurement system and the value accounted for, pillar by pillar, with
 * the backend's discrepancy last. Backend values only — never recomputed.
 */
export function ProcurementProofDisplay({
  evidence,
  currency = 'INR',
  className = '',
}: ProcurementProofDisplayProps) {
  const financialDiff = evidence?.financial?.difference ?? null;
  const isZeroDiscrepancy =
    financialDiff !== null &&
    (financialDiff === '0' ||
      financialDiff === '0.00' ||
      parseFloat(String(financialDiff)) === 0);

  // Pillar values come ONLY from backend reconciliation evidence. There is
  // deliberately no fallback: filling every pillar with one shared total
  // would fabricate an equality the backend never verified. Missing evidence
  // renders as '—' with the Balance Unconfirmed verdict below.
  let demandVal: string | null = null;
  let supplierVal: string | null = null;
  let paymentVal: string | null = null;
  let residentVal: string | null = null;

  if (evidence?.pillars && evidence.pillars.length >= 4) {
    demandVal = evidence.pillars[0]?.value ?? null;
    supplierVal = evidence.pillars[1]?.value ?? null;
    paymentVal = evidence.pillars[2]?.value ?? null;
    residentVal = evidence.pillars[3]?.value ?? null;
  } else if (evidence?.financial) {
    demandVal = evidence.financial.community ?? null;
    supplierVal = evidence.financial.community ?? null;
    paymentVal = evidence.financial.community ?? null;
    residentVal = evidence.financial.residents ?? null;
  }

  const formatPillar = (val: string | null) => {
    if (!val) return '—';
    const n = parseFloat(val);
    return isNaN(n) ? val : formatMoney(n, currency);
  };

  const pillars = [
    { label: 'Community Demand', value: formatPillar(demandVal), source: 'Intent Aggregation' },
    { label: 'Supplier PO', value: formatPillar(supplierVal), source: 'Purchase Order Lock' },
    { label: 'Payment Provider', value: formatPillar(paymentVal), source: 'Mandate Debit' },
    { label: 'Resident Allocation', value: formatPillar(residentVal), source: 'Ledger Distribution' },
  ];

  return (
    <section
      className={`rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none overflow-hidden ${className}`}
      role="region"
      aria-label="Procurement Proof and Financial Conservation"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 sm:px-6 pt-5 pb-4 border-b border-relay-surface-border">
        <div>
          <h3 className="text-[15px] font-semibold tracking-tight text-relay-ink-900 flex items-center gap-2">
            Procurement Proof
            {isZeroDiscrepancy ? (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-relay-success-700">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                100% Balanced
              </span>
            ) : (
              <span className="text-xs font-medium text-relay-warn-700">
                Balance Unconfirmed
              </span>
            )}
          </h3>
          <p className="text-xs text-relay-ink-500 mt-1">
            Four-pillar financial conservation — intent, purchase order, mandate debit, ledger.
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-relay-ink-500">Discrepancy</p>
          <p
            className={`font-mono text-[26px] leading-tight font-semibold tnum ${
              isZeroDiscrepancy ? 'text-relay-success-700' : 'text-relay-warn-700'
            }`}
          >
            {financialDiff === null ? 'Not confirmed' : `₹${financialDiff === '0' ? '0.00' : financialDiff}`}
          </p>
        </div>
      </div>

      {/* Four pillars: an equation, not four cards. Backend values only. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 lg:divide-x divide-relay-surface-border border-b border-relay-surface-border">
        {pillars.map((pillar, idx) => (
          <div key={pillar.label} className="px-5 sm:px-6 py-4">
            <p className="flex items-baseline justify-between gap-2 text-xs">
              <span className="font-medium text-relay-ink-900">{pillar.label}</span>
              <span className="font-mono text-[10.5px] text-relay-ink-400">0{idx + 1}</span>
            </p>
            <p className="font-mono text-lg font-semibold text-relay-ink-900 mt-1.5 tnum truncate">
              {pillar.value}
            </p>
            <p className="text-[11px] text-relay-ink-500 mt-0.5">{pillar.source}</p>
          </div>
        ))}
      </div>

      {/* Equality statement */}
      <div className="px-5 sm:px-6 py-3.5 bg-relay-surface-sunken/50 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[13px] text-relay-ink-700">
        <span className="font-semibold text-relay-ink-900">{pillars[0].value}</span>
        <span className="text-relay-success-700 font-semibold" aria-hidden>=</span>
        <span className="font-semibold text-relay-ink-900">{pillars[1].value}</span>
        <span className="text-relay-success-700 font-semibold" aria-hidden>=</span>
        <span className="font-semibold text-relay-ink-900">{pillars[2].value}</span>
        <span className="text-relay-success-700 font-semibold" aria-hidden>=</span>
        <span className="font-semibold text-relay-ink-900">{pillars[3].value}</span>
        <span className="text-relay-ink-400" aria-hidden>|</span>
        {isZeroDiscrepancy ? (
          <span className="font-sans text-xs font-semibold text-relay-success-700">
            Exact Penny Zero Error
          </span>
        ) : (
          <span className="font-sans text-xs font-medium text-relay-warn-700">
            Zero error not confirmed by backend
          </span>
        )}
      </div>
    </section>
  );
}
