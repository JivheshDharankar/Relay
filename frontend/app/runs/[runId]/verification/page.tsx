'use client';

import React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { BadgeCheck, ArrowRight, MoveRight } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/feedback/Feedback';
import { StageDetailShell, EvidenceFacts } from '@/components/runs/StageDetailShell';
import { getFulfillmentEvidence } from '@/lib/workflow/runEvidence';
import { formatDateTime } from '@/lib/format';

export default function VerificationStagePage() {
  const params = useParams();
  const runId = params?.runId as string;

  return (
    <StageDetailShell
      runId={runId}
      slug="verification"
      eyebrow="Stage 10 · Verify"
      description="Fulfillment verification — confirming what was delivered before money is finally reconciled."
    >
      {(run) => {
        const evidence = getFulfillmentEvidence(run);
        if (!evidence || (!evidence.status && !evidence.trackingCode)) {
          return (
            <EmptyState
              title="No verification evidence"
              description="This run returned no delivery artifact to verify against."
            />
          );
        }
        const delivered = evidence.status === 'DELIVERED' || evidence.status === 'VERIFIED';
        return (
          <div className="space-y-4">
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
                  <div className="flex items-center gap-2.5">
                    <span className="text-sm font-semibold text-relay-ink-900">FULFILL</span>
                    <Badge variant={evidence.status ? 'info' : 'neutral'} size="sm">
                      {evidence.status ?? 'unknown'}
                    </Badge>
                  </div>
                  <MoveRight className="h-5 w-5 text-relay-primary-600 rotate-90 sm:rotate-0" aria-hidden />
                  <div className="flex items-center gap-2.5">
                    <span className="text-sm font-semibold text-relay-ink-900">VERIFY</span>
                    {delivered ? (
                      <Badge variant="success">VERIFIED</Badge>
                    ) : (
                      <Badge variant="warning">PENDING</Badge>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <BadgeCheck className="h-4 w-4 text-relay-success-600" aria-hidden />
                  Verification evidence
                </CardTitle>
                <CardDescription>
                  {delivered
                    ? 'Delivery confirmed by the backend delivery record.'
                    : 'Delivery recorded but not yet confirmed delivered.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <EvidenceFacts
                  facts={[
                    { label: 'Method', value: evidence.verificationEvidenceType ?? 'Backend delivery confirmation' },
                    ...(evidence.verifiedBy ? [{ label: 'Verified by', value: evidence.verifiedBy }] : []),
                    ...(evidence.verifiedAt ? [{ label: 'Verified at', value: formatDateTime(evidence.verifiedAt) }] : []),
                    ...(evidence.verificationSimulated === true ? [{ label: 'Provenance', value: 'Simulated verification evidence' }] : []),
                    { label: 'Delivery state', value: evidence.status ?? '—' },
                    { label: 'Tracking reference', value: evidence.trackingCode ?? '—' },
                    { label: 'Dispatched at', value: formatDateTime(evidence.dispatchedAt) },
                    { label: 'Delivered at', value: formatDateTime(evidence.deliveredAt) },
                    { label: 'Supplier', value: evidence.supplierName ?? '—' },
                  ]}
                />
              </CardContent>
            </Card>

            <Link
              href="/verification"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-relay-primary-600 hover:text-relay-primary-700 min-h-[32px]"
            >
              Open Verification workspace
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        );
      }}
    </StageDetailShell>
  );
}
