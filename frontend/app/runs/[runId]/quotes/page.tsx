'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { EmptyState } from '@/components/feedback/Feedback';
import { StageDetailShell } from '@/components/runs/StageDetailShell';
import { QuoteComparison } from '@/components/market/QuoteComparison';
import { getQuoteEvidence, type QuoteEvidence } from '@/lib/workflow/runEvidence';
import { getSuppliers } from '@/lib/api';
import type { VerifiedSupplier } from '@/types';

function QuotesBody({ evidence, runId }: { evidence: QuoteEvidence; runId: string }) {
  const [catalog, setCatalog] = useState<VerifiedSupplier[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSuppliers()
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch(() => {
        // MOQ enrichment is supplementary; quotes stand alone.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4">
      <QuoteComparison
        evidence={evidence}
        moqFor={(supplierId) => {
          const entry = catalog
            ?.find((s) => s.id === supplierId)
            ?.catalog.find((c) => evidence.productName && c.name === evidence.productName);
          return entry ? `${entry.moq} ${entry.unit}` : null;
        }}
        linkSupplier={(supplierId, name) =>
          supplierId ? (
            <Link href={`/market/suppliers/${supplierId}?run=${encodeURIComponent(runId)}`} className="hover:underline">
              {name}
            </Link>
          ) : (
            name
          )
        }
      />
      <p className="text-xs text-relay-ink-500 leading-relaxed">
        Totals, SLA, reliability, and scores are backend-ranked values. MOQ is joined
        from the verified community catalog where the supplier lists this product —
        shown only when the backend provides it.
      </p>
    </div>
  );
}

export default function QuotesStagePage() {
  const params = useParams();
  const runId = params?.runId as string;

  return (
    <StageDetailShell
      runId={runId}
      slug="quotes"
      eyebrow="Stage 04 · Quote"
      description="Normalized supplier offers ranked by the backend — the procurement intelligence workspace for this run."
    >
      {(run) => {
        const evidence = getQuoteEvidence(run);
        if (!evidence) {
          return (
            <EmptyState
              title="No quote evidence"
              description="This run returned no ranked offers from the backend."
            />
          );
        }
        return <QuotesBody evidence={evidence} runId={runId} />;
      }}
    </StageDetailShell>
  );
}
