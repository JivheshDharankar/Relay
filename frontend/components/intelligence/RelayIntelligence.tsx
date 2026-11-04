import React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { IntelligenceNote } from '@/lib/workflow/intelligence';

/**
 * Relay Intelligence — concise conclusions Meta reasoning drew from
 * verified backend evidence. Never chain-of-thought: outcomes, constraints,
 * and the evidence behind them. AI recommends; Relay verifies and executes.
 */
export function RelayIntelligence({
  notes,
  href,
  compact = false,
}: {
  notes: IntelligenceNote[];
  href?: string;
  compact?: boolean;
}) {
  if (notes.length === 0) return null;
  const shown = compact ? notes.slice(0, 3) : notes;

  return (
    <section
      aria-label="Relay Intelligence"
      className="rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none overflow-hidden"
    >
      <div className="px-5 pt-4 pb-3 sm:px-6 border-b border-relay-surface-border">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[15px] font-semibold tracking-tight text-relay-ink-900">
            Relay Intelligence
          </h3>
          {href && (
            <Link
              href={href}
              className="inline-flex items-center gap-1 text-xs font-semibold text-relay-primary-700 hover:text-relay-primary-600 min-h-[32px]"
            >
              Inspect evidence
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          )}
        </div>
        <p className="text-xs text-relay-ink-500 mt-1">
          What Muse concluded from verified backend evidence. It recommends — Relay verifies and executes.
        </p>
      </div>
      <ul className="divide-y divide-relay-surface-border">
        {shown.map((note) => (
          <li key={note.stage} className="px-5 sm:px-6 py-3">
            <p className="font-mono text-[11px] text-relay-ink-500">
              {note.title}
            </p>
            {note.lines.map((line, i) => (
              <p key={i} className="text-sm text-relay-ink-900 leading-relaxed mt-0.5">
                {line}
              </p>
            ))}
          </li>
        ))}
      </ul>
      {compact && notes.length > shown.length && (
        <p className="px-5 sm:px-6 py-3 text-xs text-relay-ink-500 border-t border-relay-surface-border">
          +{notes.length - shown.length} more in the full run view.
        </p>
      )}
    </section>
  );
}
