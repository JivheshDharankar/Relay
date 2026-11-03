import React from 'react';
import { CheckCircle2, XCircle, Scale } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import type { ReconEvidence } from '@/lib/workflow/runEvidence';
import { cn } from '@/lib/utils';

function CheckRow({ label, passed }: { label: string; passed: boolean | null }) {
  return (
    <li className="flex items-center justify-between gap-2 py-2 border-b border-relay-surface-border last:border-0">
      <span className="text-sm text-relay-ink-700">{label}</span>
      {passed === null ? (
        <span className="text-xs text-relay-ink-500">No evidence</span>
      ) : passed ? (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-relay-success-700">
          <CheckCircle2 className="h-4 w-4" aria-hidden /> Passed
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-relay-danger-700">
          <XCircle className="h-4 w-4" aria-hidden /> Failed
        </span>
      )}
    </li>
  );
}

/**
 * Four-pillar reconciliation display. Values rendered exactly as the backend
 * reported them; the balanced verdict comes from backend verdicts only.
 */
export function ReconPillars({ evidence }: { evidence: ReconEvidence }) {
  // Judge each run by its own backend vocabulary: the workflow engine
  // reports quantity/monetary/supplier-obligation/payment checks, while the
  // legacy chain reports product/society integrity instead.
  const balanced =
    evidence.source === 'workflow-engine'
      ? evidence.isReconciled === true &&
        evidence.status === 'RECONCILED' &&
        evidence.quantity.passed === true &&
        evidence.financial.passed === true &&
        evidence.supplierPassed !== false &&
        evidence.paymentPassed !== false
      : evidence.isReconciled === true &&
        evidence.status === 'RECONCILED' &&
        evidence.quantity.passed === true &&
        evidence.financial.passed === true &&
        evidence.productPassed === true &&
        evidence.societyPassed === true;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <Scale className="h-4 w-4 text-relay-primary-600" aria-hidden />
              Four pillars
            </CardTitle>
            <span className="text-xs text-relay-ink-500 font-mono">{evidence.source}</span>
          </div>
          <CardDescription>
            Status: <strong className="font-semibold">{evidence.status ?? 'unknown'}</strong>
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {evidence.pillars.length === 0 ? (
            <p className="text-sm text-relay-ink-600">No pillar values in this reconciliation evidence.</p>
          ) : (
            <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-relay-surface-border rounded-lg border border-relay-surface-border overflow-hidden">
              {evidence.pillars.map((pillar, i) => (
                <li
                  key={pillar.label}
                  className="bg-white px-4 py-4"
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">
                    {i + 1}. {pillar.label}
                  </p>
                  <p className="text-[22px] font-bold text-relay-ink-900 font-mono mt-1.5 break-all">
                    ₹{pillar.value}
                  </p>
                  <p className="text-[10px] font-mono text-relay-ink-400 mt-1 truncate">{pillar.source}</p>
                </li>
              ))}
            </ol>
          )}
          <div
            className={cn(
              'mt-4 rounded-lg border px-4 sm:px-5 py-4 leading-relaxed',
              balanced
                ? 'border-relay-success-100 bg-relay-success-50'
                : 'border-relay-warn-100 bg-relay-warn-50'
            )}
            role="status"
          >
            {balanced ? (
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-relay-success-700">
                    Discrepancy
                  </p>
                  <p className="font-mono font-semibold text-3xl text-relay-success-700 mt-0.5 tnum">
                    {evidence.financial.difference !== null
                      ? `₹${evidence.financial.difference}`
                      : 'Not confirmed'}
                  </p>
                </div>
                <p className="text-[13px] text-relay-success-700 max-w-md sm:text-right">
                  All four financial pillars reconcile. Reported discrepancy: ₹
                  {evidence.financial.difference ?? '?'} · quantity{' '}
                  {evidence.quantity.difference ?? '?'} — exactly as the backend verified.
                </p>
              </div>
            ) : (
              <p className="text-sm text-relay-warn-700">
                <strong className="font-semibold">Balance not confirmed.</strong> Financial
                difference: {evidence.financial.difference ?? 'unknown'} · Quantity
                difference: {evidence.quantity.difference ?? 'unknown'}.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Backend checks</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <ul>
            <CheckRow label="Quantity conservation" passed={evidence.quantity.passed} />
            <CheckRow label="Financial conservation" passed={evidence.financial.passed} />
            {evidence.source === 'workflow-engine' ? (
              <>
                <CheckRow label="Supplier obligations" passed={evidence.supplierPassed ?? null} />
                <CheckRow label="Payment verified" passed={evidence.paymentPassed ?? null} />
              </>
            ) : (
              <>
                <CheckRow label="Product integrity" passed={evidence.productPassed} />
                <CheckRow label="Society boundary" passed={evidence.societyPassed} />
              </>
            )}
          </ul>
          {(evidence.quantity.community !== null || evidence.financial.community !== null) && (
            <dl className="grid grid-cols-2 gap-3 mt-3 border-t border-relay-surface-border pt-3 text-[13px]">
              <div>
                <dt className="text-[11px] text-relay-ink-500">Community total (qty)</dt>
                <dd className="font-semibold tnum">{evidence.quantity.community ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-[11px] text-relay-ink-500">Resident sum (qty)</dt>
                <dd className="font-semibold tnum">{evidence.quantity.residents ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-[11px] text-relay-ink-500">Community total (₹)</dt>
                <dd className="font-semibold tnum">₹{evidence.financial.community ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-[11px] text-relay-ink-500">Resident sum (₹)</dt>
                <dd className="font-semibold tnum">₹{evidence.financial.residents ?? '—'}</dd>
              </div>
            </dl>
          )}
          {evidence.discrepancies.length > 0 && (
            <ul className="mt-3 space-y-1">
              {evidence.discrepancies.map((d) => (
                <li key={d} className="text-xs font-mono text-relay-danger-700 break-words" role="alert">
                  {d}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-relay-ink-500 mt-3">
            Values are rendered exactly as the backend reported them. Relay never
            recomputes money in the browser.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
