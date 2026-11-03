'use client';

import React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FileSignature, ArrowRight } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/feedback/Feedback';
import { StageDetailShell, EvidenceFacts } from '@/components/runs/StageDetailShell';
import { getCommitmentEvidence, getFulfillmentEvidence } from '@/lib/workflow/runEvidence';
import { formatDateTime, formatMoney, shortRef } from '@/lib/format';

export default function CommitmentStagePage() {
  const params = useParams();
  const runId = params?.runId as string;

  return (
    <StageDetailShell
      runId={runId}
      slug="commitment"
      eyebrow="Stage 07 · Commit"
      description="The purchase commitment — products, quantities, and conservation into the community order."
    >
      {(run) => {
        const evidence = getCommitmentEvidence(run);
        const fulfillment = getFulfillmentEvidence(run);
        if (!evidence) {
          return (
            <EmptyState
              title="No commitment evidence"
              description="This run returned no purchase commitment from the backend."
            />
          );
        }
        return (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="flex items-center gap-2">
                    <FileSignature className="h-4 w-4 text-relay-primary-600" aria-hidden />
                    Commitment {evidence.id ? shortRef(evidence.id, 'COMM-') : ''}
                  </CardTitle>
                  {evidence.status && (
                    <Badge variant={evidence.status === 'DELIVERED' || evidence.status === 'RECONCILED' ? 'success' : 'info'}>
                      {evidence.status}
                    </Badge>
                  )}
                </div>
                <CardDescription>
                  Created by the backend. No frontend or LLM control over financial commitment.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <EvidenceFacts
                  facts={[
                    { label: 'Community order', value: evidence.id ? shortRef(evidence.id, 'COMM-') : '—' },
                    { label: 'Status', value: evidence.status ?? '—' },
                    {
                      label: 'Committed total',
                      value: evidence.totalAmount !== null ? formatMoney(evidence.totalAmount) : '—',
                    },
                    { label: 'Line items', value: evidence.itemsCount !== null ? String(evidence.itemsCount) : '—' },
                    { label: 'Delivery deadline', value: formatDateTime(evidence.deliveryDeadline) },
                    ...(evidence.isDuplicate ? [{ label: 'Replay', value: 'Idempotent replay — committed once' }] : []),
                  ]}
                />
              </CardContent>
            </Card>

            {fulfillment?.poReference && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Supplier purchase order</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <EvidenceFacts
                    facts={[
                      { label: 'PO reference', value: fulfillment.poReference },
                      { label: 'Supplier', value: fulfillment.supplierName ?? '—' },
                      { label: 'Confirmed ETA', value: formatDateTime(fulfillment.confirmedDeliveryEta) },
                    ]}
                  />
                </CardContent>
              </Card>
            )}

            <Card className="bg-relay-navy-900 border-relay-navy-900 text-white">
              <CardContent className="pt-5">
                <p className="text-sm leading-relaxed text-relay-navy-100">
                  Quantity conservation: the committed community total must equal the
                  sum of resident allocations. The full proof lives in reconciliation.
                </p>
                <Link
                  href={`/runs/${runId}/reconciliation`}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-white hover:text-relay-navy-100 mt-3 min-h-[32px]"
                >
                  View conservation proof
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </CardContent>
            </Card>
          </div>
        );
      }}
    </StageDetailShell>
  );
}
