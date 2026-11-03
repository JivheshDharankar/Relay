'use client';

import React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PieChart, ArrowRight } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/feedback/Feedback';
import { StageDetailShell, EvidenceFacts } from '@/components/runs/StageDetailShell';
import { getAllocationEvidence, getCommitmentEvidence } from '@/lib/workflow/runEvidence';
import { shortRef } from '@/lib/format';

export default function AllocationStagePage() {
  const params = useParams();
  const runId = params?.runId as string;

  return (
    <StageDetailShell
      runId={runId}
      slug="allocation"
      eyebrow="Stage 11 · Allocate"
      description="How the community procurement was distributed back to resident orders."
    >
      {(run) => {
        const evidence = getAllocationEvidence(run);
        const commitment = getCommitmentEvidence(run);
        if (!evidence) {
          return (
            <EmptyState
              title="No allocation evidence"
              description="This run returned no allocation artifact from the backend."
            />
          );
        }
        return (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <PieChart className="h-4 w-4 text-relay-primary-600" aria-hidden />
                  Distribution record
                </CardTitle>
                <CardDescription>
                  Backend-authoritative allocation of the community order.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <EvidenceFacts
                  facts={[
                    {
                      label: 'Allocations posted',
                      value: evidence.allocationsCount !== null ? String(evidence.allocationsCount) : '—',
                    },
                    {
                      label: 'Community order',
                      value: evidence.communityOrderId ? shortRef(evidence.communityOrderId, 'COMM-') : '—',
                    },
                    {
                      label: 'Delivery batch',
                      value: evidence.deliveryId ? shortRef(evidence.deliveryId, 'DLV-') : '—',
                    },
                    {
                      label: 'Commitment status',
                      value: commitment?.status ?? '—',
                    },
                  ]}
                />
              </CardContent>
            </Card>

            <Card className="bg-relay-navy-900 border-relay-navy-900 text-white">
              <CardContent className="pt-5">
                <p className="text-sm leading-relaxed text-relay-navy-100">
                  Conservation proof: allocated resident quantities must sum exactly to the
                  committed community total. Individual resident allocations stay private —
                  only the ordering resident sees their own share.
                </p>
                {run.residentOrderId && (
                  <Link
                    href={`/orders/${run.residentOrderId}`}
                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-white hover:text-relay-navy-100 mt-3 min-h-[32px]"
                  >
                    View your allocated order
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </Link>
                )}
              </CardContent>
            </Card>
          </div>
        );
      }}
    </StageDetailShell>
  );
}
