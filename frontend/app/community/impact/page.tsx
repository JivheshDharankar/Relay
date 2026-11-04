'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, TrendingUp } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Container } from '@/components/ui';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { AuthRequiredState, ErrorState, LoadingState } from '@/components/feedback/Feedback';
import { useSession } from '@/lib/session/SessionContext';
import { useCommunityData } from '@/lib/community/useCommunityData';
import { formatPercent, formatQuantity } from '@/lib/format';

export default function ImpactPage() {
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const { community, error, forbidden } = useCommunityData(sessionStatus === 'authenticated');

  React.useEffect(() => {
    if (forbidden) router.push('/login');
  }, [forbidden, router]);

  const pools = community?.activeDemandPools ?? [];
  const chartData = pools.map((p) => ({
    name: p.productName.length > 18 ? `${p.productName.slice(0, 17)}…` : p.productName,
    fullName: p.productName,
    savings: p.estimatedSavingsPct,
  }));

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <Link
            href="/community"
            className="inline-flex items-center gap-1.5 text-[13px] text-relay-ink-600 hover:text-relay-ink-900 font-medium min-h-[32px]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Community
          </Link>

          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-relay-primary-600">
              Community · Impact
            </p>
            <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-relay-ink-900 mt-1 flex items-center gap-2">
              <TrendingUp className="h-6 w-6 text-relay-success-600" aria-hidden />
              Collective impact
            </h1>
            <p className="text-sm text-relay-ink-600 mt-1.5 max-w-2xl leading-relaxed">
              What autonomous pooling achieves for the community — aggregates only.
            </p>
          </div>

          {sessionStatus === 'loading' && <LoadingState title="Loading impact" />}
          {sessionStatus === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}
          {sessionStatus === 'authenticated' && error && <ErrorState title="Impact unavailable" description={error} />}
          {sessionStatus === 'authenticated' && !error && !community && <LoadingState title="Loading impact" />}

          {sessionStatus === 'authenticated' && !error && community && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {[
                  { label: 'Community orders', value: String(community.totalCommunityOrders) },
                  { label: 'Active pools', value: String(pools.length) },
                  { label: 'Residents pooled', value: String(community.registeredResidents) },
                  { label: 'Collective savings', value: formatPercent(community.collectiveSavingsEstimatePct) },
                ].map((s) => (
                  <div key={s.label} className="rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none px-4 py-3.5">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">{s.label}</p>
                    <p className="font-mono text-lg font-semibold tnum mt-1">{s.value}</p>
                  </div>
                ))}
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Estimated savings by pool</CardTitle>
                  <CardDescription>Backend demand-model estimates per active pool.</CardDescription>
                </CardHeader>
                <CardContent>
                  {chartData.length === 0 ? (
                    <p className="text-sm text-relay-ink-600">No active pools to chart.</p>
                  ) : (
                    <div className="h-64 w-full" role="img" aria-label="Bar chart of estimated savings by pool">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 24 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#E2E9F2" horizontal={false} />
                          <XAxis type="number" tick={{ fontSize: 11 }} stroke="#64748B" unit="%" />
                          <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} stroke="#33415C" />
                          <Tooltip
                            formatter={(value) => [
                              typeof value === 'number' ? formatPercent(value) : String(value),
                              'Est. savings',
                            ]}
                            labelFormatter={(_, payload) => payload?.[0]?.payload?.fullName ?? ''}
                          />
                          <Bar dataKey="savings" radius={[0, 4, 4, 0]}>
                            {chartData.map((entry) => (
                              <Cell key={entry.fullName} fill="#059669" />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Pooled volume</CardTitle>
                  <CardDescription>Backend-reported totals per pool. No per-resident breakdown.</CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  {pools.length === 0 ? (
                    <p className="text-sm text-relay-ink-600">No pooled volume right now.</p>
                  ) : (
                    <ul className="space-y-2">
                      {pools.map((p) => (
                        <li key={p.productId} className="flex items-baseline justify-between gap-3 text-sm border-b border-relay-surface-border last:border-0 pb-2">
                          <span className="font-medium text-relay-ink-900 truncate">{p.productName}</span>
                          <span className="tnum text-relay-ink-700 shrink-0">
                            {formatQuantity(p.totalQuantity, p.unit)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
