'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckCircle2,
  CircleDashed,
  XCircle,
  Loader2,
  Lock,
  Users,
  Wallet,
  Clock,
  ArrowRight,
  RotateCcw,
  Building2,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { DemoJourneyStrip } from './DemoJourneyStrip';
import { CopyRef } from '@/components/ui/CopyRef';
import { StageSpecificCard } from './StageSpecificCards';
import { MissionSummaryCard } from './MissionSummaryCard';
import { FailureExperienceCard } from './FailureExperienceCard';
import { CANONICAL_STAGES, mapRunToStages, STAGE_SLUGS } from '@/lib/workflow/stageEvidence';
import type { CanonicalStage, StageEvidence, StageState } from '@/lib/workflow/stageEvidence';
import {
  getAllocationEvidence,
  getCommitmentEvidence,
  getFulfillmentEvidence,
  getIntentEvidence,
  getNegotiationEvidence,
  getPaymentEvidence,
  getQuoteEvidence,
  getReconEvidence,
  getSupplierEvidence,
} from '@/lib/workflow/runEvidence';
import { formatMoney, formatMoneyCompact, shortRef } from '@/lib/format';
import { getRunIntelligence } from '@/lib/workflow/intelligence';
import { RelayIntelligence } from '@/components/intelligence/RelayIntelligence';
import type { ProcurementRun } from '@/lib/workflow/types';
import type { ResidentProfile } from '@/types';

export type MissionStageVisualState = 'PENDING' | 'ACTIVE' | 'VERIFIED' | 'FAILED' | 'NO_EVIDENCE';

/**
 * Backend failure codes that mean "Relay understood enough to know it needs
 * clarification" rather than a hard system failure. Rendered with AI-native
 * clarification UX instead of the generic blocked state.
 */
export const CLARIFICATION_CODES = new Set([
  'UNMAPPABLE_PRODUCT',
  'MISSING_QUANTITY',
  'MISSING_UNIT',
  'UNSUPPORTED_UNIT',
  'SCHEMA_VIOLATION',
  'PROMPT_INJECTION_DETECTED',
  'NO_TOOL_CALL',
  'NO_TOOL_CALLS',
  'EMPTY_REQUEST',
  'INTENT_RESOLUTION_FAILED',
  'INTENT_RESOLUTION_MISMATCH',
]);

interface AutonomousMissionControlProps {
  prompt: string;
  run: ProcurementRun;
  isProcessing: boolean;
  residentProfile?: ResidentProfile | null;
  mandateLimit?: number | null;
  mandateCurrency?: string;
  onReturnToCommandCenter: () => void;
  onRetry?: (prompt: string) => void;
  onContinueMission?: (amendedPrompt: string) => void;
  initialRevealedIndex?: number;
  /**
   * Demo-only presentation: same real mission APIs/data, but completed
   * evidence renders instantly, the 7-milestone journey leads, and the
   * 13-stage rail collapses into an expander. Never changes data semantics.
   */
  demoMode?: boolean;
}

/**
 * Demo-only collapsible wrapper. Normal mode renders children unchanged
 * (plain fragment — identical DOM).
 */
function DemoDetails({
  demoMode,
  label,
  children,
}: {
  demoMode?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  if (!demoMode) return <>{children}</>;
  return (
    <details className="rounded-lg border border-relay-surface-border bg-white shadow-card px-4 py-3 sm:px-5">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-relay-ink-900 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 text-relay-primary-600" aria-hidden />
        {label}
      </summary>
      <div className="pt-4">{children}</div>
    </details>
  );
}

export function AutonomousMissionControl({
  prompt,
  run,
  isProcessing,
  residentProfile,
  mandateLimit,
  mandateCurrency = 'INR',
  onReturnToCommandCenter,
  onRetry,
  onContinueMission,
  initialRevealedIndex,
  demoMode = false,
}: AutonomousMissionControlProps) {
  // Respect prefers-reduced-motion
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      setPrefersReducedMotion(mq.matches);
      const listener = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
      mq.addEventListener('change', listener);
      return () => mq.removeEventListener('change', listener);
    }
  }, []);

  const stages: StageEvidence[] = useMemo(() => {
    if (run.agentResponse || run.status === 'complete' || run.status === 'failed') {
      return mapRunToStages(run);
    }
    // Default 13 canonical stages when waiting for backend
    return CANONICAL_STAGES.map((s) => ({
      stage: s.stage,
      label: s.label,
      state: 'absent' as StageState,
      summary: 'Awaiting verified execution evidence.',
      facts: [],
      source: null,
    }));
  }, [run]);

  // Extract rich evidence verbatim from backend artifacts
  const intent = useMemo(() => getIntentEvidence(run), [run]);
  const suppliers = useMemo(() => getSupplierEvidence(run), [run]);
  const quotes = useMemo(() => getQuoteEvidence(run), [run]);
  const negotiation = useMemo(() => getNegotiationEvidence(run), [run]);
  const commitment = useMemo(() => getCommitmentEvidence(run), [run]);
  const payment = useMemo(() => getPaymentEvidence(run), [run]);
  const fulfillment = useMemo(() => getFulfillmentEvidence(run), [run]);
  const recon = useMemo(() => getReconEvidence(run), [run]);
  const allocation = useMemo(() => getAllocationEvidence(run), [run]);
  const intelligence = useMemo(() => getRunIntelligence(run), [run]);

  const runId = run.agentResponse?.runId || '';
  const firstFailedIndex = stages.findIndex((s) => s.state === 'failed');
  const hasFailedStage = firstFailedIndex !== -1;
  const verifiedCount = stages.filter((s) => s.state === 'verified').length;

  // Launch transition state: displays the dedicated Autonomous Mission launch
  // view when freshly triggered from the Command Center, preventing instant jump.
  const [isLaunching, setIsLaunching] = useState<boolean>(
    () => initialRevealedIndex === undefined
  );

  useEffect(() => {
    if (initialRevealedIndex !== undefined) return;
    // Demo mode skips the launch hold: verified evidence renders immediately.
    if (demoMode) {
      setIsLaunching(false);
      return;
    }
    // Guaranteed minimum launch presentation (850ms) so user visibly experiences
    // the mission transition before progressive stage reveal begins.
    const timer = setTimeout(() => {
      setIsLaunching(false);
    }, 850);
    return () => clearTimeout(timer);
  }, [initialRevealedIndex, demoMode]);

  // Reveal state machine:
  // - While launching/processing: revealedIndex = -1
  // - When completed/failed: step through 0 -> targetIndex
  const [revealedIndex, setRevealedIndex] = useState<number>(() => {
    if (initialRevealedIndex !== undefined) return initialRevealedIndex;
    return -1;
  });

  const [activeStageIndex, setActiveStageIndex] = useState<number>(-1);
  const [showSummary, setShowSummary] = useState<boolean>(() => {
    return initialRevealedIndex === 12;
  });

  // Inline evidence expansion: stages render compact; the reveal
  // auto-follows the active stage until the resident interacts, after which
  // each row toggles independently so several evidence cards can stay open
  // side by side for review.
  const [expandedSet, setExpandedSet] = useState<number[]>([]);
  const [userPinnedExpand, setUserPinnedExpand] = useState(false);
  useEffect(() => {
    if (userPinnedExpand || demoMode) return;
    if (hasFailedStage && firstFailedIndex >= 0 && revealedIndex >= firstFailedIndex) {
      setExpandedSet([firstFailedIndex]);
    } else if (activeStageIndex >= 0) {
      setExpandedSet([activeStageIndex]);
    }
  }, [activeStageIndex, revealedIndex, hasFailedStage, firstFailedIndex, userPinnedExpand, demoMode]);

  // True elapsed time from the backend-stamped run start (never simulated).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isProcessing) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isProcessing]);
  const elapsedLabel = useMemo(() => {
    if (!run.startedAt) return null;
    const start = Date.parse(run.startedAt);
    if (Number.isNaN(start)) return null;
    const end = run.finishedAt ? Date.parse(run.finishedAt) : nowMs;
    const secs = Math.max(0, Math.floor((end - start) / 1000));
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  }, [run.startedAt, run.finishedAt, nowMs]);

  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Trigger sequential reveal when backend completes and launch transition finishes
  useEffect(() => {
    if (isProcessing || isLaunching) {
      setRevealedIndex(-1);
      setActiveStageIndex(-1);
      setShowSummary(false);
      return;
    }

    if (run.status === 'complete' || run.status === 'failed') {
      const maxTarget = hasFailedStage ? firstFailedIndex : 12;

      if (prefersReducedMotion || demoMode) {
        setRevealedIndex(maxTarget);
        setActiveStageIndex(maxTarget);
        setShowSummary(run.status === 'complete' && !hasFailedStage);
        return;
      }

      // Sequential animation progression
      let current = 0;
      setActiveStageIndex(0);
      setRevealedIndex(0);

      const stepIntervalMs = 260;

      const advance = () => {
        if (current < maxTarget) {
          current += 1;
          setActiveStageIndex(current);
          setRevealedIndex(current);
          timerRef.current = setTimeout(advance, stepIntervalMs);
        } else {
          setActiveStageIndex(maxTarget);
          if (run.status === 'complete' && !hasFailedStage) {
            timerRef.current = setTimeout(() => {
              setShowSummary(true);
            }, 350);
          }
        }
      };

      timerRef.current = setTimeout(advance, stepIntervalMs);

      return () => {
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }
  }, [isProcessing, isLaunching, run.status, hasFailedStage, firstFailedIndex, prefersReducedMotion, demoMode]);

  // Compute visual state for stage node i
  const getStageVisualState = (i: number): MissionStageVisualState => {
    if (isProcessing || isLaunching) {
      return 'PENDING';
    }
    if (i > revealedIndex) {
      return 'PENDING';
    }
    if (i === activeStageIndex && i < (hasFailedStage ? firstFailedIndex : 12)) {
      return 'ACTIVE';
    }
    const backendState = stages[i]?.state;
    if (backendState === 'failed') return 'FAILED';
    if (backendState === 'verified') return 'VERIFIED';
    return 'NO_EVIDENCE';
  };

  // Requested items for summary: strictly authoritative backend intent
  // evidence. Multi-item runs list every evidenced line; single-item keeps
  // the legacy row. Never prompt-derived.
  const itemsDisplay = useMemo(() => {
    if (intent?.items && intent.items.length > 1) {
      return intent.items.map((line) => ({
        name: line.productName,
        quantity: line.quantity ?? null,
        unit: line.unit ?? undefined,
      }));
    }
    if (intent?.productName) {
      return [
        {
          name: intent.productName,
          quantity: intent.quantity ?? null,
          unit: intent.unit ?? undefined,
        },
      ];
    }
    return [];
  }, [intent]);

  const winningSupplier =
    quotes?.selectedSupplierName ||
    quotes?.offers?.find((o) => o.selected)?.supplierName ||
    fulfillment?.supplierName ||
    '—';
  const validatedTotal = payment?.amount ?? commitment?.totalAmount ?? null;
  const slaHours = quotes?.offers?.find((o) => o.selected)?.deliveryHours ?? null;

  const handleRetry = () => {
    if (onRetry) {
      onRetry(prompt);
    } else {
      onReturnToCommandCenter();
    }
  };

  // Mission summary block, shared by both layouts (demo renders it first).
  const summaryBlock = (
    <AnimatePresence>
      {showSummary && (
        <motion.div
          initial={prefersReducedMotion ? false : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="pt-4"
        >
          <MissionSummaryCard
            prompt={prompt}
            runId={runId}
            residentOrderId={run.residentOrderId}
            communityOrderId={run.communityOrderId}
            itemsDisplay={itemsDisplay}
            winningSupplier={winningSupplier}
            totalAmount={validatedTotal}
            currency={payment?.currency || 'INR'}
            slaHours={slaHours}
            requestedDeadlineHours={intent?.requestedDeadlineHours ?? null}
            operationalSlaHours={intent?.operationalSlaHours ?? null}
            reconEvidence={recon}
            verifiedStages={verifiedCount}
            totalStages={13}
            onReturnToCommandCenter={onReturnToCommandCenter}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div
      className="space-y-8 max-w-6xl mx-auto py-2 sm:py-4"
      role="main"
      aria-label="Relay Autonomous Mission Control"
    >
      {/* 1. MISSION HEADER — deep-navy control panel: request, state, provenance. */}
      <motion.header
        initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="relative overflow-hidden rounded-xl bg-relay-navy-950 text-white shadow-hero px-5 py-5 sm:px-7 sm:py-6"
      >
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-relay-teal-500"
          aria-hidden
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 font-mono text-[11px] text-relay-navy-200">
            <span
              className={`h-1.5 w-1.5 rounded-full ${isProcessing || isLaunching ? 'bg-relay-teal-500 animate-pulse' : hasFailedStage ? 'bg-red-400' : 'bg-emerald-400'}`}
              aria-hidden
            />
            Mission
            {runId && (
              <CopyRef value={shortRef(runId, 'RUN-')} dark className="-my-1" />
            )}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={onReturnToCommandCenter}
            className="text-xs px-2 py-1 h-auto text-relay-navy-100 hover:text-white hover:bg-white/10"
          >
            Command Center
          </Button>
        </div>

        {/* The request, verbatim. */}
        <h1 className="text-[22px] sm:text-[26px] font-semibold tracking-tight text-white mt-2.5 leading-snug">
          “{prompt}”
        </h1>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-relay-navy-200">
          {elapsedLabel && (
            <span className="font-mono">
              {isProcessing ? `Elapsed ${elapsedLabel}` : `Completed in ${elapsedLabel}`}
            </span>
          )}
          {intent?.requestedDeadlineHours != null && (
            <span>Requested within {intent.requestedDeadlineHours}h</span>
          )}
          {intent?.operationalSlaHours != null && (
            <span>Relay guarantee {intent.operationalSlaHours}h</span>
          )}
          <span className="inline-flex items-center gap-1">
            <Lock className="h-3.5 w-3.5 text-relay-navy-200" aria-hidden />
            Private request
          </span>
          <span className="inline-flex items-center gap-1">
            <Users className="h-3.5 w-3.5 text-relay-navy-200" aria-hidden />
            Community matching
          </span>
          <span className="inline-flex items-center gap-1">
            <Wallet className="h-3.5 w-3.5 text-relay-teal-500" aria-hidden />
            {mandateLimit !== null && mandateLimit !== undefined ? (
              <>
                <strong className="tnum font-semibold font-mono text-white">
                  {formatMoneyCompact(mandateLimit, mandateCurrency)}
                </strong>
                mandate
              </>
            ) : (
              'Mandate active'
            )}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5 text-relay-navy-200" aria-hidden />
            12-hour operational SLA
          </span>
        </div>

        {/* Live status line */}
        <div className="mt-4 pt-4 border-t border-white/10 flex flex-wrap items-center justify-between gap-2 text-[13px]">
          <p className="flex items-center gap-2" role="status">
            {isProcessing || isLaunching ? (
              <>
                <Loader2 className="h-4 w-4 text-relay-teal-500 animate-spin" aria-hidden />
                <span className="font-medium text-white">
                  Relay is orchestrating your autonomous procurement mission…
                </span>
              </>
            ) : hasFailedStage ? (
              <>
                <XCircle className="h-4 w-4 text-red-400" aria-hidden />
                <span className="font-medium text-white">
                  Mission execution halted at Stage {String(firstFailedIndex + 1).padStart(2, '0')}: {CANONICAL_STAGES[firstFailedIndex]?.label || 'Understand'}.
                </span>
              </>
            ) : revealedIndex < 12 ? (
              <>
                <Loader2 className="h-4 w-4 text-relay-teal-500 animate-spin" aria-hidden />
                <span className="font-medium text-white">
                  Verifying Stage {String(revealedIndex + 1).padStart(2, '0')} of 13: {CANONICAL_STAGES[revealedIndex]?.label}…
                </span>
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden />
                <span className="font-medium text-white">
                  {verifiedCount === 13
                    ? 'All 13 stages verified against authoritative backend state.'
                    : `${verifiedCount} of 13 stages verified against authoritative backend state.`}
                </span>
              </>
            )}
          </p>
          <span className="font-mono text-xs text-relay-navy-200">
            {isProcessing || isLaunching
              ? 'Initializing…'
              : hasFailedStage
                ? `Stage ${firstFailedIndex + 1} of 13`
                : revealedIndex < 12
                  ? `Stage ${Math.max(1, revealedIndex + 1)} of 13`
                  : `${verifiedCount} / 13 Stages Verified`}
          </span>
        </div>

        {/* Execution note while orchestrating */}
        {(isProcessing || isLaunching) && (
          <p className="mt-2 text-[13px] text-relay-navy-100 leading-relaxed max-w-2xl">
            Relay is coordinating your mission with the backend — resolving intent, discovering
            suppliers, and verifying every stage against authoritative state. Verified evidence
            appears below as the backend confirms it.
          </p>
        )}
      </motion.header>

      {/* Demo journey: compact milestones first (demo only). */}
      {demoMode && (
        <DemoJourneyStrip
          stages={stages}
          orchestrating={isProcessing || isLaunching}
          elapsedLabel={elapsedLabel}
        />
      )}

      {/* Demo outcome first: Mission Complete directly under the journey. */}
      {demoMode && summaryBlock}

      {/* 2. FAILURE EXPERIENCE (First-Class Product State) */}
      <AnimatePresence>
        {hasFailedStage && (
          <motion.div
            initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.25 }}
          >
            <FailureExperienceCard
              prompt={prompt}
              failedStageIndex={firstFailedIndex !== -1 ? firstFailedIndex : undefined}
              failedStageName={firstFailedIndex !== -1 ? stages[firstFailedIndex]?.label : undefined}
              clarification={
                (firstFailedIndex !== -1 &&
                  CLARIFICATION_CODES.has(stages[firstFailedIndex]?.code ?? '')) ||
                CLARIFICATION_CODES.has(run.error?.code ?? '')
              }
              errorCode={
                run.error?.code ||
                (firstFailedIndex !== -1 ? `${stages[firstFailedIndex].stage.toUpperCase()}_FAILED` : 'MISSION_BLOCKED')
              }
              errorMessage={
                run.error?.message ||
                stages[firstFailedIndex]?.summary ||
                'Relay could not complete this mission within deterministic parameters.'
              }
              errorDetail={run.error?.detail}
              onRetry={handleRetry}
              onReturnToCommandCenter={onReturnToCommandCenter}
              onContinueMission={onContinueMission}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 3. EXECUTION RAIL — one-glance mission path. Completed stages
          collapse to proof markers; the active stage holds focus; future
          stages stay quiet. Detail opens in the panel below the rail. */}
      <DemoDetails demoMode={demoMode} label="Full 13-stage proof timeline">
      <section
        aria-label="13-Stage Autonomous Procurement Lifecycle"
        className="space-y-4"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold tracking-tight text-relay-ink-900">
            Mission proof — 13 stages
          </h2>
          <span className="text-xs font-mono text-relay-ink-500 shrink-0">
            {isProcessing || isLaunching ? 'Executing…' : 'Deterministic verification'}
          </span>
        </div>
        {/* Mission progress spine: backend-derived counts only. */}
        <div
          className="h-[3px] rounded-full bg-relay-surface-sunken overflow-hidden"
          role="progressbar"
          aria-valuenow={verifiedCount}
          aria-valuemin={0}
          aria-valuemax={13}
          aria-label="Mission progress"
        >
          <motion.div
            className={`h-full rounded-full ${hasFailedStage ? 'bg-relay-danger-600' : 'bg-relay-success-600'}`}
            initial={false}
            animate={{ width: `${Math.round((verifiedCount / 13) * 100)}%` }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          />
        </div>

        <div className="rounded-lg border border-relay-surface-border bg-white shadow-card px-3 py-4 sm:px-5 sm:py-5">
          <ol className="flex flex-wrap sm:flex-nowrap items-start sm:overflow-x-auto pb-1" aria-label="Mission stages">
          {CANONICAL_STAGES.map((def, idx) => {
            const visualState = getStageVisualState(idx);
            const evidence = stages[idx] || {
              stage: def.stage,
              label: def.label,
              state: 'absent' as StageState,
              summary: 'Awaiting execution.',
              facts: [],
              source: null,
            };

            const isPending = visualState === 'PENDING';
            const isActive = visualState === 'ACTIVE';
            const isVerified = visualState === 'VERIFIED';
            const isFailed = visualState === 'FAILED';
            const isNoEvidence = visualState === 'NO_EVIDENCE';
            // Backend asked for clarification (ambiguous/understood-but-vague
            // request): same failed treatment, AI-native label.
            const isClarification =
              isFailed && CLARIFICATION_CODES.has(evidence.code ?? '');
            // Stages after a failure never executed: label honestly.
            const notRun = hasFailedStage && idx > firstFailedIndex;
            const isExpanded = expandedSet.includes(idx);
            const expandable = !isPending && !notRun;
            const orchestrating = (isProcessing || isLaunching) && idx === 0;

            const slug = STAGE_SLUGS[def.stage];
            const detailHref = runId && slug ? `/runs/${runId}/${slug}` : null;

            const statusText = isVerified
              ? 'VERIFIED'
              : isClarification
                ? 'CLARIFICATION REQUIRED'
                : isFailed
                  ? 'FAILED'
                  : isActive
                    ? 'ACTIVE'
                    : notRun
                      ? 'NOT RUN'
                      : isNoEvidence
                        ? 'NO EVIDENCE'
                        : 'PENDING';

            return (
              <li key={def.stage} className="relative w-1/4 sm:w-auto sm:min-w-[68px] sm:flex-1">
                {/* Connector to the next stage (single row only) */}
                {idx < 12 && (
                  <span
                    aria-hidden
                    className={`absolute left-1/2 top-[18px] h-px w-full transition-colors duration-300 hidden sm:block ${
                      idx < revealedIndex
                        ? stages[idx]?.state === 'failed'
                          ? 'bg-relay-danger-600'
                          : 'bg-relay-success-600'
                        : 'bg-relay-surface-border'
                    }`}
                  />
                )}
                <button
                  type="button"
                  disabled={!expandable}
                  onClick={() => {
                    if (!expandable) return;
                    setUserPinnedExpand(true);
                    setExpandedSet((prev) =>
                      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]
                    );
                  }}
                  aria-expanded={isExpanded}
                  aria-label={`${def.label} stage evidence`}
                  className={`relative z-10 flex w-full flex-col items-center gap-1.5 rounded-lg px-0.5 py-1 text-center ${
                    expandable ? 'cursor-pointer' : 'cursor-default'
                  } ${isExpanded ? 'bg-relay-navy-50' : ''}`}
                >
                  <span
                    className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold shrink-0 border transition-colors ${
                      orchestrating ? 'ring-2 ring-relay-primary-500/30 ring-offset-2 ring-offset-white' : ''
                    } ${
                      isVerified
                        ? 'bg-relay-success-600 border-relay-success-600 text-white'
                        : isFailed
                          ? 'bg-relay-danger-600 border-relay-danger-600 text-white'
                          : isActive
                            ? 'bg-relay-primary-600 border-relay-primary-600 text-white'
                            : isExpanded
                              ? 'bg-white border-relay-navy-800 text-relay-ink-900'
                              : 'bg-white border-relay-surface-border text-relay-ink-400'
                    }`}
                  >
                    {isVerified ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : isFailed ? (
                      <XCircle className="h-4 w-4" />
                    ) : isActive ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <span className="font-mono text-[11px]">{String(idx + 1).padStart(2, '0')}</span>
                    )}
                  </span>
                  <span
                    className={`text-[10px] sm:text-[11px] font-semibold leading-tight ${
                      isActive || isVerified || isExpanded ? 'text-relay-ink-900' : 'text-relay-ink-500'
                    }`}
                  >
                    {def.label}
                  </span>
                  <span
                    className={`text-[9.5px] font-semibold leading-none ${
                      isVerified
                        ? 'text-relay-success-700'
                        : isFailed
                          ? 'text-relay-danger-700'
                          : isActive
                            ? 'text-relay-primary-700'
                            : 'text-relay-ink-400'
                    }`}
                  >
                    {statusText}
                  </span>
                </button>
                {detailHref && isVerified && (
                  <span className="relative z-10 flex justify-center">
                    <Link
                      href={detailHref}
                      className="inline-flex items-center text-xs font-semibold text-relay-primary-600 hover:text-relay-primary-700 p-0.5"
                      title="Open detailed stage breakdown"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Link>
                  </span>
                )}
              </li>
            );
          })}
          </ol>
        </div>

        {/* Honest captions while orchestrating / after a halt */}
        {(isProcessing || isLaunching) && (
          <p className="px-1 text-xs italic text-relay-ink-500">
            Relay is orchestrating — verified state will appear here. Waiting for verified backend state.
          </p>
        )}
        {hasFailedStage && (
          <p className="px-1 text-xs italic text-relay-ink-500">
            Not executed — the mission halted at an earlier stage.
          </p>
        )}

        {/* Stage detail panel: expanded evidence, inline (never a page jump) */}
        <AnimatePresence initial={false}>
          {expandedSet.map((idx) => {
            const def = CANONICAL_STAGES[idx];
            const evidence = stages[idx];
            if (!def || !evidence) return null;
            const slug = STAGE_SLUGS[def.stage];
            const detailHref = runId && slug ? `/runs/${runId}/${slug}` : null;
            return (
              <motion.div
                key={`evidence-${def.stage}`}
                initial={prefersReducedMotion ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="overflow-hidden"
              >
                <div className="rounded-lg border border-relay-surface-border bg-white shadow-card p-4 sm:p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-relay-surface-border">
                    <p className="flex items-baseline gap-2 min-w-0">
                      <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-relay-ink-500 whitespace-nowrap">
                        Stage {String(idx + 1).padStart(2, '0')}
                      </span>
                      <span className="text-relay-ink-300" aria-hidden>·</span>
                      <span className="text-base font-bold text-relay-ink-900 tracking-tight truncate">
                        {def.label}
                      </span>
                    </p>
                    {detailHref && (
                      <Link
                        href={detailHref}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-relay-primary-600 hover:text-relay-primary-700 shrink-0"
                      >
                        Open detailed stage breakdown
                        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                    )}
                  </div>
                  <StageSpecificCard
                    evidence={evidence}
                    index={idx}
                    runId={runId}
                    intent={intent}
                    suppliers={suppliers}
                    quotes={quotes}
                    negotiation={negotiation}
                    commitment={commitment}
                    payment={payment}
                    fulfillment={fulfillment}
                    recon={recon}
                    allocation={allocation}
                    profile={residentProfile}
                    promptText={prompt}
                  />
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {/* Relay Intelligence: concise decision outcomes (never chain-of-thought) */}
        {!demoMode && intelligence.length > 0 && (
          <RelayIntelligence notes={intelligence} compact={run.status !== 'complete'} />
        )}
      </section>
      </DemoDetails>

      {/* Demo: concise reasoning stays visible below the collapsed proof. */}
      {demoMode && intelligence.length > 0 && (
        <RelayIntelligence notes={intelligence} compact />
      )}

      {/* Bridge: Stage 13 flows into completion on the same mission surface. */}
      {!demoMode && showSummary && (
        <div aria-hidden className="flex flex-col items-center -my-4">
          <span className="w-[2px] h-7 bg-relay-success-600" />
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-relay-success-600 text-white -mt-0.5">
            <ChevronDown className="h-3.5 w-3.5" />
          </span>
        </div>
      )}

      {/* 4. MISSION SUMMARY & PROCUREMENT PROOF (When Mission Complete) */}
      {!demoMode && summaryBlock}
    </div>
  );
}
