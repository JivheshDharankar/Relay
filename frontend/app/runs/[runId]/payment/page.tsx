'use client';

import React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { BadgeCheck, ShieldCheck, ArrowRight } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/feedback/Feedback';
import { StageDetailShell, EvidenceFacts } from '@/components/runs/StageDetailShell';
import { getPaymentEvidence } from '@/lib/workflow/runEvidence';
import { useResidentContext } from '@/lib/session/useResidentContext';
import { formatDateTime, formatMoney } from '@/lib/format';

export default function PaymentStagePage() {
  const params = useParams();
  const runId = params?.runId as string;
  const resident = useResidentContext();

  return (
    <StageDetailShell
      runId={runId}
      slug="payment"
      eyebrow="Stage 08 · Pay"
      description="Authorized settlement under the pre-authorized mandate — amounts set and settled by the backend."
    >
      {(run) => {
        const evidence = getPaymentEvidence(run);
        if (!evidence) {
          return (
            <EmptyState
              title="No payment evidence"
              description="This run returned no payment artifact from the backend."
            />
          );
        }
        // Settled verdicts across both backend vocabularies: legacy
        // requestPayment reports SUCCESS; the engine reports SUCCEEDED
        // (payment record), FULLY_PAID (summary), or PAID (commitment).
        const success =
          evidence.status === 'SUCCESS' ||
          evidence.status === 'SUCCEEDED' ||
          evidence.status === 'FULLY_PAID' ||
          evidence.status === 'PAID';
        const remaining = resident.paymentsTrusted
          ? (resident.payments?.mandate?.remainingLimit ?? null)
          : null;
        return (
          <div className="space-y-4">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-start gap-4">
                  <span
                    className={`flex h-12 w-12 items-center justify-center rounded-full border shrink-0 ${
                      success ? 'bg-relay-success-50 border-relay-success-100' : 'bg-relay-warn-50 border-relay-warn-100'
                    }`}
                  >
                    <BadgeCheck
                      className={`h-6 w-6 ${success ? 'text-relay-success-600' : 'text-relay-warn-600'}`}
                      aria-hidden
                    />
                  </span>
                  <div>
                    <p className="text-3xl font-bold tracking-tight text-relay-ink-900 tnum">
                      {evidence.amount !== null ? formatMoney(evidence.amount, evidence.currency) : '—'}
                    </p>
                    <p className="text-[13px] text-relay-ink-600 mt-1">
                      Status: <strong className="font-semibold">{evidence.status ?? 'unknown'}</strong>
                      {evidence.isDuplicate === true && ' · idempotent replay, charged once'}
                    </p>
                  </div>
                </div>
                <div className="mt-5 border-t border-relay-surface-border pt-4">
                  <EvidenceFacts
                    facts={[
                      { label: 'Provider reference', value: evidence.providerReference ?? '—' },
                      { label: 'Executed at', value: formatDateTime(evidence.executedAt) },
                      { label: 'Source artifact', value: evidence.source },
                      ...(resident.mandate
                        ? [{ label: 'Mandate limit', value: formatMoney(resident.mandate.maximumAmount, resident.mandate.currency) }]
                        : []),
                      ...(remaining !== null && resident.mandate
                        ? [{ label: 'Remaining capacity', value: formatMoney(remaining, resident.mandate.currency) }]
                        : []),
                    ]}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-5">
                <p className="flex items-start gap-2 text-sm text-relay-ink-700 leading-relaxed">
                  <ShieldCheck className="h-4 w-4 text-relay-success-600 shrink-0 mt-0.5" aria-hidden />
                  The LLM may reason about and request payment. Relay determines and
                  validates the exact amount, recipient, and authorization — this screen
                  only reports the backend record.
                </p>
                <Link
                  href="/payments"
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-relay-primary-600 hover:text-relay-primary-700 mt-3 min-h-[32px]"
                >
                  Open Payments
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Audit trail</CardTitle>
                <CardDescription>Provenance for this settlement.</CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <EvidenceFacts
                  facts={[
                    { label: 'Artifact', value: evidence.source },
                    {
                      label: 'Idempotency',
                      value:
                        evidence.isDuplicate === true
                          ? 'Replay detected — single charge enforced'
                          : evidence.isDuplicate === false
                            ? 'First execution recorded'
                            : 'Not reported for this run',
                    },
                  ]}
                />
              </CardContent>
            </Card>
          </div>
        );
      }}
    </StageDetailShell>
  );
}
