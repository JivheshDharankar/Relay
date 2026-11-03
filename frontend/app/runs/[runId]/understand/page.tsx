'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { FileText, Scale, Users } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/feedback/Feedback';
import { StageDetailShell, EvidenceFacts } from '@/components/runs/StageDetailShell';
import { getIntentEvidence } from '@/lib/workflow/runEvidence';
import { formatMoney, formatQuantity, shortRef } from '@/lib/format';

export default function UnderstandStagePage() {
  const params = useParams();
  const runId = params?.runId as string;

  return (
    <StageDetailShell
      runId={runId}
      slug="understand"
      eyebrow="Stage 01 · Understand"
      description="How Relay interpreted the natural-language command into structured procurement intent."
    >
      {(run) => {
        const intent = getIntentEvidence(run);
        if (!intent) {
          // Unmappable runs stop before any tool ran: show the command that
          // was received plus the backend's honest reason, never a fixture.
          const blocked =
            run.status === 'failed' &&
            (run.agentResponse?.steps ?? []).every((s) => !s.toolCall);
          const reason =
            blocked && run.agentResponse?.response?.trim()
              ? run.agentResponse.response.trim()
              : 'This run returned no intent artifact from the backend.';
          return (
            <EmptyState
              title={blocked ? 'Product mapping unavailable' : 'No intent evidence'}
              description={`Command received: “${run.prompt}”. ${reason}`}
            />
          );
        }
        return (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-relay-primary-600" aria-hidden />
                  Original command
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <blockquote className="rounded-lg bg-relay-navy-50 border border-relay-surface-border px-4 py-3.5 text-[15px] text-relay-ink-900 leading-relaxed">
                  “{run.prompt}”
                </blockquote>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Extracted intent</CardTitle>
                <CardDescription>Decision-level output from intent interpretation.</CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <EvidenceFacts
                  facts={
                    intent.items && intent.items.length > 1
                      ? [
                          ...intent.items.map((line) => ({
                            label: 'Item',
                            value: `${line.productName} — ${
                              line.quantity !== null
                                ? formatQuantity(line.quantity, line.unit ?? undefined)
                                : 'quantity unavailable'
                            }`,
                          })),
                          { label: 'Resident order', value: intent.orderId ? shortRef(intent.orderId, 'ORD-') : '—' },
                        ]
                      : [
                          { label: 'Product', value: intent.productName ?? '—' },
                          {
                            label: 'Quantity',
                            value:
                              intent.quantity !== null
                                ? formatQuantity(intent.quantity, intent.unit ?? undefined)
                                : '—',
                          },
                          { label: 'Unit', value: intent.unit ?? '—' },
                          { label: 'Resident order', value: intent.orderId ? shortRef(intent.orderId, 'ORD-') : '—' },
                        ]
                  }
                />
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Scale className="h-4 w-4 text-relay-primary-600" aria-hidden />
                    Mandate gate
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0 text-sm">
                  {intent.requestedAmount !== null && intent.maxAllowed !== null ? (
                    <p className="text-relay-ink-700 leading-relaxed">
                      Estimated{' '}
                      <strong className="tnum">{formatMoney(intent.requestedAmount)}</strong>{' '}
                      against a{' '}
                      <strong className="tnum">{formatMoney(intent.maxAllowed)}</strong>{' '}
                      authorized mandate
                      {intent.mandateCode && (
                        <>
                          {' '}· verdict <strong>{intent.mandateCode}</strong>
                        </>
                      )}
                      .
                    </p>
                  ) : (
                    <p className="text-relay-ink-600">No mandate-check artifact on this run.</p>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Users className="h-4 w-4 text-relay-primary-600" aria-hidden />
                    Community procurement decision
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0 text-sm">
                  {intent.groupsCount !== null ? (
                    <p className="text-relay-ink-700 leading-relaxed">
                      Compatible demand pooled across{' '}
                      <strong className="tnum">{intent.groupsCount} product groups</strong>{' '}
                      — the request rides the anonymous community batch while the unit
                      order stays private.
                    </p>
                  ) : (
                    <p className="text-relay-ink-600">No demand-pooling artifact on this run.</p>
                  )}
                </CardContent>
              </Card>
            </div>

            <p className="text-xs text-relay-ink-500 leading-relaxed">
              Hard SLA for fulfillment is 12 hours, enforced deterministically by the
              backend — intent interpretation never overrides it.
            </p>
          </div>
        );
      }}
    </StageDetailShell>
  );
}
