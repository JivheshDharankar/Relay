import React from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Honest indeterminate state for the blocking agent run. The backend exposes
 * no streaming progress, so this state explicitly says Relay is executing and
 * makes no claim about which stage is active.
 */
export function ExecutionProcessing({
  phase,
  prompt,
}: {
  phase: 'processing' | 'verifying';
  prompt: string;
}) {
  return (
    <section
      aria-label="Relay is executing"
      aria-busy="true"
      className="rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none px-5 sm:px-6 py-5"
    >
      <div className="flex items-start gap-3.5">
        <Loader2 className="h-5 w-5 animate-spin text-relay-primary-600 shrink-0 mt-0.5" aria-hidden />
        <div className="space-y-1.5 min-w-0">
          <p className="font-mono text-[11px] text-relay-ink-500">
            Execution in progress
          </p>
          <h2 className="text-base sm:text-lg font-semibold tracking-tight text-relay-ink-900">
            {phase === 'verifying'
              ? 'Verifying payment, fulfillment, and reconciliation…'
              : 'Relay is executing your mission…'}
          </h2>
          <p className="text-sm text-relay-ink-600 leading-relaxed max-w-2xl">
            Understanding intent, pooling community demand, qualifying suppliers, and
            orchestrating fulfillment — inside the authorized mandate. Verified
            stages appear below once the backend responds.
          </p>
          <p className="text-xs text-relay-ink-500 font-mono truncate">“{prompt}”</p>
        </div>
      </div>
    </section>
  );
}
