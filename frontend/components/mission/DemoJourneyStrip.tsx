'use client';

import React from 'react';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import type { StageEvidence } from '@/lib/workflow/stageEvidence';

/**
 * Demo-only compact journey: 7 mission milestones derived from the SAME
 * truthful 13-stage backend evidence (indices into CANONICAL_STAGES).
 * COMPLETE (index 12) is represented by the Mission Complete card itself.
 */
const DEMO_NODES: Array<{ label: string; indices: number[] }> = [
  { label: 'Understand', indices: [0] },
  { label: 'Discover', indices: [1, 2] },
  { label: 'Quote/Negotiate', indices: [3, 4] },
  { label: 'Select', indices: [5, 6] },
  { label: 'Pay', indices: [7] },
  { label: 'Fulfill', indices: [8, 9] },
  { label: 'Reconcile', indices: [10, 11] },
];

type NodeState = 'VERIFIED' | 'FAILED' | 'PENDING' | 'NO_EVIDENCE';

function mergeState(states: Array<StageEvidence['state'] | undefined>): NodeState {
  if (states.some((s) => s === 'failed')) return 'FAILED';
  if (states.length > 0 && states.every((s) => s === 'verified')) return 'VERIFIED';
  return 'NO_EVIDENCE';
}

interface DemoJourneyStripProps {
  stages: StageEvidence[];
  orchestrating: boolean;
  elapsedLabel: string | null;
}

export function DemoJourneyStrip({ stages, orchestrating, elapsedLabel }: DemoJourneyStripProps) {
  return (
    <section aria-label="Demo mission journey" className="rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none px-4 py-3.5 sm:px-5">
      <ol className="flex flex-wrap sm:flex-nowrap items-start sm:overflow-x-auto">
        {DEMO_NODES.map((node, ni) => {
          const nodeState: NodeState = orchestrating
            ? 'PENDING'
            : mergeState(node.indices.map((i) => stages[i]?.state));
          const titles = node.indices
            .map((i) => stages[i])
            .filter(Boolean)
            .map((s) => `${s!.label}: ${s!.summary}`)
            .join(' · ');
          return (
            <li key={node.label} className="relative w-1/4 sm:w-auto sm:min-w-[76px] sm:flex-1">
              {ni > 0 && (
                <span
                  aria-hidden
                  className={`absolute right-1/2 top-[10px] h-px w-full hidden sm:block ${
                    nodeState === 'VERIFIED' ? 'bg-relay-success-600' : 'bg-relay-surface-border'
                  }`}
                />
              )}
              <span className="relative flex flex-col items-center gap-1 text-center" title={titles || node.label}>
                <span className="flex h-5 w-5 items-center justify-center bg-[#12161D] relative z-10">
                  {nodeState === 'VERIFIED' ? (
                    <CheckCircle2 className="h-5 w-5 text-relay-success-600" aria-hidden />
                  ) : nodeState === 'FAILED' ? (
                    <XCircle className="h-5 w-5 text-relay-danger-600" aria-hidden />
                  ) : nodeState === 'PENDING' ? (
                    <Loader2 className="h-4 w-4 text-relay-primary-600 animate-spin" aria-hidden />
                  ) : (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-relay-surface-border text-[9px] font-semibold text-relay-ink-400" aria-hidden>
                      {ni + 1}
                    </span>
                  )}
                </span>
                <span className="text-[11px] font-medium leading-tight text-relay-ink-900">
                  {node.label}
                </span>
                <span
                  className={`text-[9.5px] font-medium leading-none ${
                    nodeState === 'VERIFIED'
                      ? 'text-relay-success-700'
                      : nodeState === 'FAILED'
                        ? 'text-relay-danger-700'
                        : 'text-relay-ink-400'
                  }`}
                >
                  {nodeState === 'NO_EVIDENCE' ? 'NO EVIDENCE' : nodeState}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-2.5 pt-2.5 border-t border-relay-surface-border text-center text-[11.5px] text-relay-ink-500" role="status">
        {orchestrating
          ? `Relay is executing your mission${elapsedLabel ? ` · ${elapsedLabel}` : ''} — verified state appears here.`
          : 'Every milestone above reflects verified backend evidence.'}
      </p>
    </section>
  );
}
