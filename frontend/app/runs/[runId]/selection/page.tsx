'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { ShieldCheck, Trophy } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/feedback/Feedback';
import { StageDetailShell } from '@/components/runs/StageDetailShell';
import { getQuoteEvidence } from '@/lib/workflow/runEvidence';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

export default function SelectionStagePage() {
  const params = useParams();
  const runId = params?.runId as string;

  return (
    <StageDetailShell
      runId={runId}
      slug="selection"
      eyebrow="Stage 06 · Select"
      description="The winning offer — AI recommendation separated from deterministic validation."
    >
      {(run) => {
        const evidence = getQuoteEvidence(run);
        if (!evidence || evidence.offers.length === 0) {
          return (
            <EmptyState
              title="No selection evidence"
              description="This run returned no ranked offers to select from."
            />
          );
        }
        const eligible = evidence.offers.filter((o) => o.eligible !== false);
        const winner = evidence.offers.find((o) => o.selected) ?? null;
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card className="border-relay-primary-100">
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Trophy className="h-4 w-4 text-relay-ink-400" aria-hidden />
                    Relay Intelligence
                  </CardTitle>
                  <CardDescription>Recommends the strongest eligible candidate.</CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  {evidence.selectedSupplierName || winner || evidence.selectionReason ? (
                    <>
                      <p className="text-lg font-bold text-relay-ink-900 tracking-tight">
                        {evidence.selectedSupplierName ?? winner?.supplierName ?? 'Winning supplier selected'}
                      </p>
                      <p className="text-[13px] text-relay-ink-600 mt-1 leading-relaxed">
                        Strongest price/SLA tradeoff across {eligible.length} eligible{' '}
                        {eligible.length === 1 ? 'quote' : 'quotes'}.
                      </p>
                      {evidence.selectionReason && (
                        <p className="text-[13px] text-relay-ink-600 mt-1 leading-relaxed">
                          Why: {evidence.selectionReason}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-relay-ink-600">No recommendation recorded.</p>
                  )}
                </CardContent>
              </Card>
              <Card className="border-relay-success-100">
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-relay-success-600" aria-hidden />
                    Selection Validator
                  </CardTitle>
                  <CardDescription>Deterministic Relay verification.</CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  {winner ? (
                    <div className="flex items-center gap-3">
                      <Badge variant="success">VERIFIED</Badge>
                      <p className="text-[13px] text-relay-ink-600">
                        Eligibility, SLA, and totals re-checked by the backend.
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-relay-ink-600">No validated selection recorded.</p>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardContent className="pt-5 px-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[560px]">
                    <thead>
                      <tr className="border-b border-relay-surface-border text-left text-[11px] uppercase tracking-[0.08em] text-relay-ink-500">
                        <th className="px-5 py-3 font-semibold">Candidate</th>
                        <th className="px-4 py-3 font-semibold text-right">Total</th>
                        <th className="px-4 py-3 font-semibold text-right">SLA</th>
                        <th className="px-4 py-3 font-semibold text-right">Score</th>
                        <th className="px-5 py-3 font-semibold text-right">Verdict</th>
                      </tr>
                    </thead>
                    <tbody>
                      {evidence.offers.map((o) => (
                        <tr
                          key={o.supplierId ?? o.supplierName}
                          className={cn(
                            'border-b border-relay-surface-border last:border-0',
                            o.selected && 'bg-relay-primary-50/60'
                          )}
                        >
                          <td className="px-5 py-3 font-medium text-relay-ink-900">
                            <span className="inline-flex items-center gap-1.5">
                              {o.selected && <Trophy className="h-3.5 w-3.5 text-relay-primary-600" aria-hidden />}
                              {o.supplierName}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right font-semibold tnum">
                            {o.totalPrice !== null ? formatMoney(o.totalPrice) : '—'}
                          </td>
                          <td className="px-4 py-3 text-right tnum text-relay-ink-700">
                            {o.deliveryHours !== null ? `${o.deliveryHours}h` : '—'}
                          </td>
                          <td className="px-4 py-3 text-right tnum text-relay-ink-700">
                            {o.compositeScore !== null ? o.compositeScore.toFixed(4) : '—'}
                          </td>
                          <td className="px-5 py-3 text-right">
                            {o.selected ? (
                              <Badge variant="info" size="sm">Selected</Badge>
                            ) : o.eligible === false ? (
                              <Badge variant="neutral" size="sm">Ineligible</Badge>
                            ) : (
                              <span className="text-xs text-relay-ink-500">Outranked</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>
        );
      }}
    </StageDetailShell>
  );
}
