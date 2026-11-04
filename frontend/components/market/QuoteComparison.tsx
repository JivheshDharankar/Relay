import React from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Info, Trophy } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import type { QuoteEvidence } from '@/lib/workflow/runEvidence';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

function shortName(name: string): string {
  return name.length > 20 ? `${name.slice(0, 19)}…` : name;
}

/** Shared normalized quote comparison: chart + dense table. Backend values only. */
export function QuoteComparison({
  evidence,
  moqFor,
  linkSupplier,
}: {
  evidence: QuoteEvidence;
  moqFor?: (supplierId: string | null) => string | null;
  linkSupplier?: (supplierId: string | null, name: string) => React.ReactNode;
}) {
  const chartData = evidence.offers.map((o) => ({
    name: shortName(o.supplierName),
    fullName: o.supplierName,
    total: o.totalPrice,
    eligible: o.eligible !== false,
    selected: o.selected,
  }));

  return (
    <div className="space-y-4">
      {evidence.commercialBasisSimulated === true && (
        <p className="rounded-2xl border border-relay-surface-border bg-relay-surface-sunken px-3 py-2 text-[11px] leading-relaxed text-relay-ink-600">
          <strong className="font-semibold text-relay-ink-800">Commercial quote simulated.</strong>{' '}
          Supplier identity and discovery are real; commercial response is simulated.
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Validated totals</CardTitle>
          <CardDescription>
            {evidence.productName && evidence.quantity !== null && evidence.unit
              ? `Normalized offers for ${evidence.quantity} ${evidence.unit} ${evidence.productName}`
              : 'Normalized offers for this run'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-60 w-full" role="img" aria-label="Bar chart of validated offer totals">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E3E7EB" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} stroke="#64748B" />
                <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 11 }} stroke="#33415C" />
                <Tooltip
                  formatter={(value) => [
                    typeof value === 'number' ? formatMoney(value) : String(value),
                    'Validated total',
                  ]}
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.fullName ?? ''}
                />
                <Bar dataKey="total" radius={[0, 4, 4, 0]}>
                  {chartData.map((entry) => (
                    <Cell
                      key={entry.fullName}
                      fill={entry.selected ? '#0A1730' : entry.eligible ? '#93C5FD' : '#CBD5E1'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {evidence.commercialBasisSimulated === true && (
        <p className="flex items-start gap-2 rounded-2xl border border-relay-warn-100 bg-relay-warn-50 px-4 py-3 text-[13px] text-relay-warn-700" role="note">
          <Info className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
          <span>
            <strong className="font-semibold">Commercial terms simulated.</strong> Supplier discovery is
            real; the commercial responses below are simulated by the backend and are not confirmed
            supplier offers.
          </span>
        </p>
      )}

      {evidence.selectionReason && (
        <div className="rounded-2xl border border-relay-success-100 bg-relay-success-50 px-5 py-4">
          <p className="font-mono text-[11px] text-relay-success-700">
            Relay pick — backend-selected winner
          </p>
          <p className="text-sm leading-relaxed mt-1.5 text-relay-ink-900">
            <span className="font-semibold">Why Relay chose this: </span>
            {evidence.selectionReason}
          </p>
          {evidence.hasNegotiatedWinner === true && evidence.winningTotal != null && (
            <p className="font-mono text-xs text-relay-ink-700 mt-2 tnum">
              Winning negotiated quote {formatMoney(evidence.winningTotal)} — final terms may differ from the received quote below.
            </p>
          )}
        </div>
      )}
      <Card>
        <CardContent className="pt-5 px-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="border-b border-relay-surface-border text-left text-[11px] text-relay-ink-500">
                  <th className="px-5 py-3 font-semibold">Supplier</th>
                  <th className="px-4 py-3 font-semibold text-right">Total</th>
                  <th className="px-4 py-3 font-semibold text-right">SLA</th>
                  <th className="px-4 py-3 font-semibold text-right">Reliability</th>
                  {moqFor && <th className="px-4 py-3 font-semibold text-right">MOQ</th>}
                  <th className="px-5 py-3 font-semibold text-right">Score</th>
                </tr>
              </thead>
              <tbody>
                {evidence.offers.map((o) => (
                  <tr
                    key={o.supplierId ?? o.supplierName}
                    className={cn(
                      'border-b border-relay-surface-border last:border-0',
                      o.selected && 'bg-relay-success-50 shadow-[inset_2px_0_0_0_#059669]',
                      o.eligible === false && 'opacity-60'
                    )}
                  >
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center gap-1.5 font-medium text-relay-ink-900">
                        {o.selected && <Trophy className="h-3.5 w-3.5 text-relay-primary-600 shrink-0" aria-hidden />}
                        {linkSupplier ? linkSupplier(o.supplierId, o.supplierName) : o.supplierName}
                      </span>
                      {o.eligible === false && (
                        <span className="ml-2 text-[11px] font-medium text-relay-ink-500">Mismatch · ineligible</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tnum text-relay-ink-900">
                      {o.totalPrice !== null ? formatMoney(o.totalPrice) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right tnum text-relay-ink-700">
                      {o.deliveryHours !== null ? `${o.deliveryHours}h` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right tnum text-relay-ink-700">
                      {o.reliabilityScore !== null
                        ? `${(o.reliabilityScore <= 1 ? o.reliabilityScore * 100 : o.reliabilityScore).toFixed(0)}%`
                        : '—'}
                    </td>
                    {moqFor && (
                      <td className="px-4 py-3 text-right tnum text-relay-ink-700">
                        {moqFor(o.supplierId) ?? '—'}
                      </td>
                    )}
                    <td className="px-5 py-3 text-right tnum text-relay-ink-700">
                      {o.compositeScore !== null ? o.compositeScore.toFixed(4) : '—'}
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
}
