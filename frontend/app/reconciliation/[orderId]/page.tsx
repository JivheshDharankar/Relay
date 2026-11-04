'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Scale, Play } from 'lucide-react';
import { Container } from '@/components/ui';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import {
  AuthRequiredState,
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/feedback/Feedback';
import { ReconPillars } from '@/components/finance/ReconPillars';
import { reconReportToEvidence } from '@/lib/workflow/reconAdapter';
import { ApiClientError, getOrders, reconcileCommunityOrder } from '@/lib/api';
import type { PortalOrder, ReconciliationReport } from '@/types';
import { useSession } from '@/lib/session/SessionContext';
import { formatMoney, shortRef } from '@/lib/format';

export default function ReconciliationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const communityOrderId = params?.orderId as string;

  const [matches, setMatches] = useState<PortalOrder[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionStatus !== 'authenticated' || !communityOrderId) return;
    let cancelled = false;
    getOrders()
      .then((all) => {
        if (!cancelled) {
          setMatches(all.filter((o) => o.communityOrder?.id === communityOrderId));
          setLoadError(null);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
          router.push('/login');
          return;
        }
        setLoadError(err instanceof Error ? err.message : 'Failed to load order context');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionStatus, communityOrderId, router]);

  const runVerification = async () => {
    setVerifying(true);
    setVerifyError(null);
    try {
      setReport(await reconcileCommunityOrder(communityOrderId));
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <Link
            href="/reconciliation"
            className="inline-flex items-center gap-1.5 text-[13px] text-relay-ink-600 hover:text-relay-ink-900 font-medium min-h-[32px]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            All reconciliation
          </Link>

          {sessionStatus === 'loading' && <LoadingState title="Loading reconciliation" />}
          {sessionStatus === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}
          {sessionStatus === 'authenticated' && loadError && (
            <ErrorState title="Context unavailable" description={loadError} />
          )}
          {sessionStatus === 'authenticated' && !loadError && matches === null && (
            <LoadingState title="Loading reconciliation" />
          )}
          {sessionStatus === 'authenticated' && !loadError && matches !== null && matches.length === 0 && (
            <EmptyState
              title="No allocation found"
              description="None of your orders were allocated from this community order."
              actionLabel="All reconciliation"
              onAction={() => router.push('/reconciliation')}
            />
          )}

          {sessionStatus === 'authenticated' && !loadError && matches !== null && matches.length > 0 && (
            <>
              <div>
                <p className="font-mono text-xs font-semibold text-relay-ink-900">
                  {shortRef(communityOrderId, 'COMM-')}
                </p>
                <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-relay-ink-900 mt-1 flex items-center gap-2">
                  <Scale className="h-6 w-6 text-relay-success-600" aria-hidden />
                  Conservation proof
                </h1>
                <p className="text-sm text-relay-ink-600 mt-1">
                  {matches[0].communityOrder!.supplierName} · {matches[0].communityOrder!.status}
                </p>
              </div>

              {!report ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Run backend verification</CardTitle>
                    <CardDescription>
                      Executes the deterministic reconciliation check for this community order and
                      returns the authoritative four-pillar report.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-3">
                    <Button onClick={() => void runVerification()} isLoading={verifying}>
                      {!verifying && <Play className="h-4 w-4" aria-hidden />}
                      {verifying ? 'Verifying…' : 'Verify reconciliation'}
                    </Button>
                    {verifyError && (
                      <p className="text-sm text-relay-danger-700" role="alert">
                        {verifyError}
                      </p>
                    )}
                    <div className="border-t border-relay-surface-border pt-3">
                      <p className="text-[13px] font-semibold text-relay-ink-900">Your share in this batch</p>
                      <ul className="mt-2 space-y-1.5">
                        {matches.map((o) => (
                          <li key={o.id} className="flex items-center justify-between gap-3 text-sm">
                            <Link
                              href={`/orders/${o.id}`}
                              className="font-mono text-[13px] text-relay-primary-600 hover:underline"
                            >
                              {shortRef(o.id, 'ORD-')}
                            </Link>
                            <span className="font-semibold tnum">{formatMoney(o.totalAmount, o.currency)}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs text-relay-ink-500 mt-2">
                        Only your own share is shown. The verification report covers the full community batch.
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-4">
                  <ReconPillars evidence={reconReportToEvidence(report)} />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => void runVerification()} isLoading={verifying}>
                      Re-run verification
                    </Button>
                    <Link
                      href={`/allocation/${communityOrderId}`}
                      className="inline-flex items-center justify-center text-sm px-4 py-2 gap-2 min-h-[38px] font-semibold rounded-2xl border border-transparent text-relay-primary-600 hover:bg-relay-primary-50 transition-colors"
                    >
                      View allocation
                    </Link>
                  </div>
                  {verifyError && (
                    <p className="text-sm text-relay-danger-700" role="alert">
                      {verifyError}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
