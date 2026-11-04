import React from 'react';
import Link from 'next/link';
import { CheckCircle2, CircleDashed, XCircle, ChevronRight, FileCheck2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CanonicalStage, StageEvidence, StageState } from '@/lib/workflow/stageEvidence';

export const STAGE_SLUGS: Record<CanonicalStage, string | null> = {
  UNDERSTAND: 'understand',
  DISCOVER: 'discover',
  QUALIFY: 'qualify',
  QUOTE: 'quotes',
  NEGOTIATE: 'negotiation',
  SELECT: 'selection',
  COMMIT: 'commitment',
  PAY: 'payment',
  FULFILL: 'fulfillment',
  VERIFY: 'verification',
  ALLOCATE: 'allocation',
  RECONCILE: 'reconciliation',
  COMPLETE: null,
};

const STATE_META: Record<
  StageState,
  { icon: React.ComponentType<{ className?: string }>; iconClass: string; pill: string; label: string }
> = {
  verified: {
    icon: CheckCircle2,
    iconClass: 'text-relay-success-600',
    pill: 'bg-relay-success-50 border-relay-success-100 text-relay-success-700',
    label: 'Verified',
  },
  absent: {
    icon: CircleDashed,
    iconClass: 'text-relay-ink-400',
    pill: 'bg-relay-navy-50 border-relay-surface-border text-relay-ink-600',
    label: 'No evidence',
  },
  failed: {
    icon: XCircle,
    iconClass: 'text-relay-danger-600',
    pill: 'bg-relay-danger-50 border-relay-danger-100 text-relay-danger-700',
    label: 'Failed',
  },
};

function StageNode({
  evidence,
  index,
  total,
  runId,
  reveal,
}: {
  evidence: StageEvidence;
  index: number;
  total: number;
  runId?: string;
  reveal?: boolean;
}) {
  const [open, setOpen] = React.useState(evidence.state === 'failed');
  const meta = STATE_META[evidence.state];
  const Icon = meta.icon;
  const hasFacts = evidence.facts.length > 0;
  const slug = STAGE_SLUGS[evidence.stage];
  const detailHref = runId && slug ? `/runs/${runId}/${slug}` : runId ? `/runs/${runId}` : null;

  const card = (
    <div
      className={cn(
        'rounded-2xl border bg-[#12161D] shadow-none px-4 sm:px-5 py-4 transition-colors',
        evidence.state === 'failed' ? 'border-relay-danger-100' : 'border-relay-surface-border',
        detailHref && 'hover:border-relay-navy-200 cursor-pointer'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] text-relay-ink-500">
            {String(index + 1).padStart(2, '0')} · {evidence.stage}
          </p>
          <h3 className="text-[15px] font-semibold text-relay-ink-900 tracking-tight mt-0.5 flex items-center gap-1.5">
            {evidence.label}
            {detailHref && <ChevronRight className="h-4 w-4 text-relay-ink-400" aria-hidden />}
          </h3>
        </div>
        <span
          className={cn(
            'inline-flex items-center rounded border text-[11px] font-semibold px-2 py-[3px] shrink-0',
            meta.pill
          )}
        >
          {meta.label}
        </span>
      </div>

      <p className="mt-1.5 text-sm text-relay-ink-700 leading-relaxed">{evidence.summary}</p>

      {(evidence.source || hasFacts) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {evidence.source && (
            <span className="inline-flex items-center gap-1 text-[11px] font-mono text-relay-ink-500">
              <FileCheck2 className="h-3 w-3" aria-hidden />
              {evidence.source}
            </span>
          )}
          {hasFacts && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpen((v) => !v);
              }}
              aria-expanded={open}
              className="inline-flex items-center gap-1 text-xs font-semibold text-relay-primary-600 hover:underline min-h-[28px]"
            >
              {open ? 'Hide details' : 'Show details'}
            </button>
          )}
        </div>
      )}

      {open && hasFacts && (
        <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 border-t border-relay-surface-border pt-3">
          {evidence.facts.map((fact) => (
            <div key={`${fact.label}-${fact.value}`} className="min-w-0">
              <dt className="text-[11px] font-medium text-relay-ink-500">{fact.label}</dt>
              <dd className="text-[13px] text-relay-ink-900 font-medium break-words tnum">
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );

  return (
    <li
      className={cn('relative pl-9 sm:pl-11', reveal && 'relay-evidence-in')}
      style={reveal ? { animationDelay: `${Math.min(index * 120, 1440)}ms` } : undefined}
    >
      {index < total - 1 && (
        <span
          aria-hidden
          className={cn(
            'absolute left-[11px] sm:left-[13px] top-9 bottom-[-10px] w-px',
            evidence.state === 'verified'
              ? 'bg-relay-success-600/50'
              : evidence.state === 'failed'
                ? 'bg-relay-danger-600/40'
                : 'bg-relay-surface-border'
          )}
        />
      )}
      <span
        className={cn(
          'absolute left-0 sm:left-[2px] top-[18px] rounded-full bg-[#12161D] shadow-none ring-1 ring-relay-surface-border',
          reveal && evidence.state === 'verified' && 'relay-illuminate'
        )}
        style={reveal ? { animationDelay: `${Math.min(index * 120, 1440)}ms` } : undefined}
      >
        <Icon className={cn('h-6 w-6', meta.iconClass)} aria-hidden />
      </span>
      {detailHref ? (
        <Link href={detailHref} aria-label={`${evidence.label} stage details`}>
          {card}
        </Link>
      ) : (
        card
      )}
    </li>
  );
}

/**
 * The shared 13-stage autonomous journey. Every node reflects backend
 * evidence only. Sequential `reveal` is presentation of an already-arrived
 * blocking response — never simulated live progress.
 */
export function StageJourney({
  stages,
  runId,
  reveal = false,
  heading = true,
}: {
  stages: StageEvidence[];
  runId?: string;
  reveal?: boolean;
  heading?: boolean;
}) {
  const verified = stages.filter((s) => s.state === 'verified').length;
  const failed = stages.filter((s) => s.state === 'failed').length;

  return (
    <section aria-label="Relay autonomous journey" className="space-y-4">
      {heading && (
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 pb-3 border-b border-relay-surface-border">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-relay-ink-900">
              Mission journey
            </h2>
          </div>
          <div className="sm:text-right">
            <p className="text-sm font-semibold text-relay-ink-900 tnum">
              {verified} of {stages.length} verified
              {failed > 0 && <span className="text-relay-danger-600"> · {failed} failed</span>}
            </p>
            <p className="text-xs text-relay-ink-500 leading-relaxed">
              Every verified stage cites its backend artifact — never simulated.
            </p>
          </div>
        </div>
      )}
      <ol className="space-y-2.5">
        {stages.map((evidence, index) => (
          <StageNode
            key={evidence.stage}
            evidence={evidence}
            index={index}
            total={stages.length}
            runId={runId}
            reveal={reveal}
          />
        ))}
      </ol>
    </section>
  );
}
