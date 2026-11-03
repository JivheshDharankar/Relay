'use client';

import React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, BadgeCheck, CreditCard } from 'lucide-react';
import { Container } from '@/components/ui';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { AuthRequiredState, EmptyState, LoadingState } from '@/components/feedback/Feedback';
import { useSession } from '@/lib/session/SessionContext';
import { useResidentContext } from '@/lib/session/useResidentContext';
import { formatDateTime, formatMoney, shortRef } from '@/lib/format';

export default function PaymentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const resident = useResidentContext();
  const paymentId = params?.paymentId as string;

  const trusted = resident.paymentsTrusted ? resident.payments : null;
  const txn = trusted?.transactions.find((t) => t.id === paymentId) ?? null;

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-4xl mx-auto">
          <Link
            href="/payments"
            className="inline-flex items-center gap-1.5 text-[13px] text-relay-ink-600 hover:text-relay-ink-900 font-medium min-h-[32px]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            All payments
          </Link>

          {sessionStatus === 'loading' && <LoadingState title="Loading payment" />}
          {sessionStatus === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}
          {sessionStatus === 'authenticated' && resident.loading && <LoadingState title="Loading payment" />}
          {sessionStatus === 'authenticated' && !resident.loading && !txn && (
            <EmptyState
              title="Payment not found"
              description="No settlement with this reference exists in your attributed history."
              actionLabel="All payments"
              onAction={() => router.push('/payments')}
            />
          )}

          {sessionStatus === 'authenticated' && !resident.loading && txn && (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <p className="font-mono text-xs font-semibold text-relay-ink-900">
                    {shortRef(txn.id, 'PAY-')}
                  </p>
                  <h1 className="text-2xl font-bold tracking-tight text-relay-ink-900 mt-1 flex items-center gap-2">
                    <CreditCard className="h-6 w-6 text-relay-primary-600" aria-hidden />
                    Settlement record
                  </h1>
                </div>
                <Badge variant={txn.status === 'SUCCESS' ? 'success' : txn.status === 'FAILED' ? 'error' : 'warning'}>
                  {txn.status}
                </Badge>
              </div>

              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-start gap-4">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-relay-success-50 border border-relay-success-100 shrink-0">
                      <BadgeCheck className="h-6 w-6 text-relay-success-600" aria-hidden />
                    </span>
                    <div>
                      <p className="text-3xl font-bold tracking-tight tnum">
                        {formatMoney(txn.amount, txn.currency)}
                      </p>
                      <p className="text-[13px] text-relay-ink-600 mt-1">
                        {txn.itemDescription || 'Procurement settlement'}
                      </p>
                    </div>
                  </div>
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 mt-5 border-t border-relay-surface-border pt-4 text-sm">
                    <div className="border-b border-relay-surface-border pb-2.5">
                      <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">Provider reference</dt>
                      <dd className="font-mono text-[13px] mt-1 break-all">{txn.providerReference ?? '—'}</dd>
                    </div>
                    <div className="border-b border-relay-surface-border pb-2.5">
                      <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">Executed at</dt>
                      <dd className="font-medium mt-1">{formatDateTime(txn.executedAt)}</dd>
                    </div>
                    <div className="border-b border-relay-surface-border pb-2.5">
                      <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">Order</dt>
                      <dd className="font-mono text-[13px] mt-1">{shortRef(txn.orderId, 'ORD-')}</dd>
                    </div>
                    {txn.failureCode && (
                      <div className="border-b border-relay-surface-border pb-2.5">
                        <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">Failure code</dt>
                        <dd className="font-mono text-[13px] mt-1 text-relay-danger-700">{txn.failureCode}</dd>
                      </div>
                    )}
                  </dl>
                  <div className="mt-4">
                    <Link
                      href={`/orders/${txn.orderId}`}
                      className="text-[13px] font-semibold text-relay-primary-600 hover:underline min-h-[32px] inline-flex items-center"
                    >
                      View order record
                    </Link>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Audit</CardTitle>
                  <CardDescription>Provenance for this settlement.</CardDescription>
                </CardHeader>
                <CardContent className="pt-0 text-sm">
                  <p className="text-relay-ink-700 leading-relaxed">
                    Settled by the backend payment executor under mandate authorization.
                    Idempotency is enforced server-side: replays reference the original
                    charge and never double-settle.
                  </p>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
