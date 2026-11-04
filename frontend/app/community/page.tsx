'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Building2, Layers, Lock, ShieldCheck, TrendingUp } from 'lucide-react';
import { Container, PageHeader } from '@/components/ui';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { AuthRequiredState, EmptyState, ErrorState, LoadingState } from '@/components/feedback/Feedback';
import { useSession } from '@/lib/session/SessionContext';
import { useCommunityData } from '@/lib/community/useCommunityData';
import { formatPercent, formatQuantity } from '@/lib/format';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none px-4 py-3.5">
      <p className="text-xs text-relay-ink-500">{label}</p>
      <p className="font-mono text-lg font-semibold text-relay-ink-900 tnum mt-1">{value}</p>
    </div>
  );
}

export default function CommunityPage() {
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const { community, error, forbidden } = useCommunityData(sessionStatus === 'authenticated');

  React.useEffect(() => {
    if (forbidden) router.push('/login');
  }, [forbidden, router]);

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <PageHeader
            eyebrow="Community"
            title="Community"
            description="Aggregated demand pools and collective savings — never individual orders."
            actions={
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-relay-success-50 border border-relay-success-100 text-xs text-relay-success-700 font-semibold">
                <ShieldCheck className="h-4 w-4" aria-hidden />
                Zero resident PII shared
              </span>
            }
          />

          {sessionStatus === 'loading' && <LoadingState title="Loading community" />}
          {sessionStatus === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}
          {sessionStatus === 'authenticated' && error && <ErrorState title="Community unavailable" description={error} />}
          {sessionStatus === 'authenticated' && !error && !community && <LoadingState title="Loading community" />}

          {sessionStatus === 'authenticated' && !error && community && (
            <>
              <div className="flex items-center gap-2 text-sm text-relay-ink-700">
                <Building2 className="h-4 w-4 text-relay-ink-500" aria-hidden />
                <strong className="font-semibold text-relay-ink-900">{community.name}</strong>
                <span className="text-relay-ink-400" aria-hidden>•</span>
                <span>{community.city}, {community.state}</span>
                {community.verified && <Badge variant="success" size="sm">Verified</Badge>}
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat label="Registered residents" value={String(community.registeredResidents)} />
                <Stat label="Verified suppliers" value={String(community.verifiedSuppliersCount)} />
                <Stat label="Community orders" value={String(community.totalCommunityOrders)} />
                <Stat label="Collective savings" value={formatPercent(community.collectiveSavingsEstimatePct)} />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Link href="/community/opportunities" className="block group">
                  <Card className="px-5 py-5 group-hover:border-relay-navy-200 transition-colors h-full">
                    <Layers className="h-5 w-5 text-relay-ink-500" aria-hidden />
                    <h2 className="text-[15px] font-semibold mt-2.5">Opportunities</h2>
                    <p className="text-[13px] text-relay-ink-600 mt-1">Live demand pools worth joining.</p>
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-relay-primary-600 mt-3">
                      Explore <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" aria-hidden />
                    </span>
                  </Card>
                </Link>
                <Link href="/community/impact" className="block group">
                  <Card className="px-5 py-5 group-hover:border-relay-navy-200 transition-colors h-full">
                    <TrendingUp className="h-5 w-5 text-relay-ink-500" aria-hidden />
                    <h2 className="text-[15px] font-semibold mt-2.5">Impact</h2>
                    <p className="text-[13px] text-relay-ink-600 mt-1">Collective volume and savings.</p>
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-relay-primary-600 mt-3">
                      View impact <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" aria-hidden />
                    </span>
                  </Card>
                </Link>
                <Link href="/community/privacy" className="block group">
                  <Card className="px-5 py-5 group-hover:border-relay-navy-200 transition-colors h-full">
                    <Lock className="h-5 w-5 text-relay-ink-500" aria-hidden />
                    <h2 className="text-[15px] font-semibold mt-2.5">Privacy model</h2>
                    <p className="text-[13px] text-relay-ink-600 mt-1">What suppliers actually see.</p>
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-relay-primary-600 mt-3">
                      How privacy works <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" aria-hidden />
                    </span>
                  </Card>
                </Link>
              </div>

              <section aria-label="Active demand pools" className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-[15px] font-semibold tracking-tight text-relay-ink-900">Active demand pools</h2>
                  <Link href="/community/opportunities" className="inline-flex items-center gap-1 text-xs font-semibold text-relay-primary-600 hover:text-relay-primary-700 min-h-[32px]">
                    All opportunities <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                </div>
                {community.activeDemandPools.length === 0 ? (
                  <EmptyState
                    title="No active pools"
                    description="There are no pooled product demands right now. New requests create pools automatically."
                  />
                ) : (
                  <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {community.activeDemandPools.slice(0, 4).map((pool) => (
                      <li key={pool.productId} className="rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none px-4 py-4">
                        <h3 className="text-sm font-semibold text-relay-ink-900 tracking-tight">{pool.productName}</h3>
                        <p className="font-mono text-xl font-semibold tnum mt-1">{formatQuantity(pool.totalQuantity, pool.unit)}</p>
                        <p className="text-xs text-relay-ink-600 mt-1 tnum">
                          {pool.contributingOrdersCount} contributing orders · est. {formatPercent(pool.estimatedSavingsPct)} savings
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
