'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Layers, Plus } from 'lucide-react';
import { Container } from '@/components/ui';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { AuthRequiredState, EmptyState, ErrorState, LoadingState } from '@/components/feedback/Feedback';
import { useSession } from '@/lib/session/SessionContext';
import { useCommunityData } from '@/lib/community/useCommunityData';
import { formatPercent, formatQuantity } from '@/lib/format';

export default function OpportunitiesPage() {
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const { community, error, forbidden } = useCommunityData(sessionStatus === 'authenticated');

  React.useEffect(() => {
    if (forbidden) router.push('/login');
  }, [forbidden, router]);

  const pools = [...(community?.activeDemandPools ?? [])].sort(
    (a, b) => b.estimatedSavingsPct - a.estimatedSavingsPct
  );

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

          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-relay-primary-600">
                Community · Opportunities
              </p>
              <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-relay-ink-900 mt-1 flex items-center gap-2">
                <Layers className="h-5 w-5 text-relay-ink-500" aria-hidden />
                Pooling opportunities
              </h1>
              <p className="text-sm text-relay-ink-600 mt-1.5 max-w-2xl leading-relaxed">
                Products where community volume is building. Requesting a pooled product
                rides the anonymous batch — better leverage, same privacy.
              </p>
            </div>
            <Link href="/">
              <Button size="sm">
                <Plus className="h-4 w-4" aria-hidden />
                Request pooled product
              </Button>
            </Link>
          </div>

          {sessionStatus === 'loading' && <LoadingState title="Loading opportunities" />}
          {sessionStatus === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}
          {sessionStatus === 'authenticated' && error && <ErrorState title="Opportunities unavailable" description={error} />}
          {sessionStatus === 'authenticated' && !error && !community && <LoadingState title="Loading opportunities" />}
          {sessionStatus === 'authenticated' && !error && community && pools.length === 0 && (
            <EmptyState
              title="No opportunities right now"
              description="New requests automatically open pools. Be the first to start one."
              actionLabel="Go to command center"
              onAction={() => router.push('/')}
            />
          )}

          {sessionStatus === 'authenticated' && !error && pools.length > 0 && (
            <ol className="space-y-3">
              {pools.map((pool, i) => (
                <li key={pool.productId}>
                  <Card className="px-5 sm:px-6 py-5">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                      <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-relay-navy-900 text-white text-sm font-bold tnum shrink-0">
                        {i + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <h2 className="text-[15px] font-semibold text-relay-ink-900 tracking-tight">
                          {pool.productName}
                        </h2>
                        <p className="text-[13px] text-relay-ink-600 tnum mt-0.5">
                          {formatQuantity(pool.totalQuantity, pool.unit)} pooled ·{' '}
                          {pool.contributingOrdersCount} contributing orders
                        </p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="text-right">
                          <p className="text-xl font-bold text-relay-success-700 tnum">
                            {formatPercent(pool.estimatedSavingsPct)}
                          </p>
                          <p className="text-[11px] text-relay-ink-500">est. savings</p>
                        </div>
                        <Badge variant="success">Active pool</Badge>
                      </div>
                    </div>
                  </Card>
                </li>
              ))}
            </ol>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">How pooling works</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 text-sm text-relay-ink-700 leading-relaxed space-y-2">
              <p>
                When compatible requests arrive, Relay aggregates them into an anonymous
                product batch. Suppliers quote against the pooled volume — never against
                individual units.
              </p>
              <p>
                Savings estimates come from the backend demand model. Only totals are
                shown here; contributor identities never leave the backend.
              </p>
            </CardContent>
          </Card>
        </div>
      </Container>
    </div>
  );
}
