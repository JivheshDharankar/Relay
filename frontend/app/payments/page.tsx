'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, CreditCard, ShieldCheck, Wallet } from 'lucide-react';
import { Container, PageHeader } from '@/components/ui';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { AuthRequiredState, EmptyState, LoadingState } from '@/components/feedback/Feedback';
import { MandateLimitEditor } from '@/components/finance/MandateLimitEditor';
import { useSession } from '@/lib/session/SessionContext';
import { useResidentContext } from '@/lib/session/useResidentContext';
import { formatDateTime, formatMoney } from '@/lib/format';

export default function PaymentsPage() {
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const resident = useResidentContext();
  const [editingLimit, setEditingLimit] = useState(false);

  const mandate = resident.mandate;
  const trusted = resident.paymentsTrusted ? resident.payments : null;
  const transactions = trusted?.transactions ?? [];

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <PageHeader
            eyebrow="Finance"
            title="Payments"
            description="Mandate authorization and settlement history. Amounts are set and settled by the backend."
          />

          {sessionStatus === 'loading' && <LoadingState title="Loading payments" />}
          {sessionStatus === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}

          {sessionStatus === 'authenticated' && resident.loading && <LoadingState title="Loading payments" />}

          {sessionStatus === 'authenticated' && !resident.loading && (
            <>
              {/* Mandate — deep-navy financial panel */}
              <section className="relative overflow-hidden rounded-xl bg-relay-navy-950 text-white shadow-hero px-5 py-5 sm:px-6" aria-label="Active mandate">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-relay-teal-500" aria-hidden />
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 className="text-[15px] font-semibold tracking-tight flex items-center gap-2">
                      <Wallet className="h-4 w-4 text-relay-teal-500" aria-hidden />
                      Active mandate
                    </h2>
                    <p className="text-xs text-relay-navy-200 mt-1">
                      Pre-authorized ceiling for autonomous procurement.
                    </p>
                  </div>
                  {mandate && (
                    <Badge variant={mandate.status === 'ACTIVE' ? 'success' : 'warning'}>
                      {mandate.status}
                    </Badge>
                  )}
                </div>
                {!mandate ? (
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3 mt-4">
                    <p className="text-sm text-relay-navy-100 flex-1">
                      No active mandate. Complete onboarding to authorize Relay spending.
                    </p>
                    <Link
                      href="/onboarding"
                      className="inline-flex items-center justify-center text-sm px-4 py-2 gap-2 min-h-[40px] font-semibold rounded-md bg-relay-teal-600 hover:bg-relay-teal-500 text-white transition-colors shrink-0"
                    >
                      Complete onboarding
                    </Link>
                  </div>
                ) : (
                  <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-4 mt-4">
                    <div>
                      <dt className="text-xs text-relay-navy-200">Authorized limit</dt>
                      <dd className="font-mono text-[22px] leading-tight font-semibold tnum mt-1">
                        {formatMoney(mandate.maximumAmount, mandate.currency)}
                      </dd>
                      <button
                        type="button"
                        onClick={() => setEditingLimit(true)}
                        className="mt-2 inline-flex items-center justify-center text-xs font-semibold rounded-md border border-white/25 text-white hover:bg-white/10 transition-colors px-3 py-1.5 min-h-[32px]"
                      >
                        Edit limit
                      </button>
                    </div>
                    <div>
                      <dt className="text-xs text-relay-navy-200">Used</dt>
                      <dd className="font-mono text-[22px] leading-tight font-semibold tnum mt-1">
                        {trusted?.mandate ? formatMoney(trusted.mandate.usedAmount, mandate.currency) : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-relay-navy-200">Remaining capacity</dt>
                      <dd className="font-mono text-[22px] leading-tight font-semibold tnum mt-1 text-relay-teal-500">
                        {trusted?.mandate ? formatMoney(trusted.mandate.remainingLimit, mandate.currency) : '—'}
                      </dd>
                      {!trusted && (
                        <p className="text-[11px] text-relay-navy-200 mt-1">
                          Capacity breakdown unavailable for this mandate.
                        </p>
                      )}
                    </div>
                  </dl>
                )}
                <p className="text-[11px] text-relay-navy-200 mt-4 pt-3 border-t border-white/10">
                  Authorization → initiation → execution → settlement. Payments run through a
                  simulated provider in this deployment — no real bank transfer occurs.
                </p>
              </section>

              {editingLimit && mandate && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Change monthly limit</CardTitle>
                    <CardDescription>
                      Your Relay authorization limit — the maximum Relay may spend on your behalf.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <MandateLimitEditor
                      mandate={mandate}
                      usedAmount={trusted?.mandate ? trusted.mandate.usedAmount : null}
                      remainingLimit={trusted?.mandate ? trusted.mandate.remainingLimit : null}
                      reload={resident.reload}
                      initialStep="edit"
                      onClose={() => setEditingLimit(false)}
                    />
                  </CardContent>
                </Card>
              )}

              {/* Transactions */}
              <section aria-label="Transactions" className="space-y-3">
                <h2 className="text-[15px] font-semibold tracking-tight text-relay-ink-900 flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-relay-ink-400" aria-hidden />
                  Settlements
                </h2>
                {!trusted ? (
                  <Card>
                    <CardContent className="pt-5">
                      <p className="flex items-start gap-2 text-sm text-relay-ink-700 leading-relaxed">
                        <ShieldCheck className="h-4 w-4 text-relay-success-600 shrink-0 mt-0.5" aria-hidden />
                        Per-transaction history is only shown when the backend attributes it
                        to this resident&apos;s mandate. Your order records always carry
                        their own payment references.
                      </p>
                    </CardContent>
                  </Card>
                ) : transactions.length === 0 ? (
                  <EmptyState
                    title="No settlements yet"
                    description="Executed payments will appear here with provider references and audit state."
                  />
                ) : (
                  <ul className="space-y-2.5">
                    {transactions.map((t) => (
                      <li key={t.id}>
                        <Link href={`/payments/${t.id}`} className="block group">
                          <Card className="px-5 py-4 group-hover:border-relay-primary-500/50 group-hover:shadow-raised transition-all">
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-relay-ink-900 truncate">
                                  {t.itemDescription || 'Procurement settlement'}
                                </p>
                                <p className="text-xs text-relay-ink-500 font-mono mt-1 truncate">
                                  {t.providerReference ?? t.id} · {formatDateTime(t.executedAt)}
                                </p>
                              </div>
                              <div className="flex items-center gap-2.5 shrink-0">
                                <Badge variant={t.status === 'SUCCESS' ? 'success' : t.status === 'FAILED' ? 'error' : 'warning'}>
                                  {t.status}
                                </Badge>
                                <span className="font-mono text-[15px] font-semibold tnum">
                                  {formatMoney(t.amount, t.currency)}
                                </span>
                                <ArrowRight className="h-4 w-4 text-relay-ink-400 group-hover:text-relay-primary-600 group-hover:translate-x-0.5 transition-all" aria-hidden />
                              </div>
                            </div>
                          </Card>
                        </Link>
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
