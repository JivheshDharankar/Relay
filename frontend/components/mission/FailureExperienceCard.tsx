'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, CornerDownLeft, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';

interface FailureExperienceCardProps {
  prompt: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorDetail?: string | null;
  failedStageIndex?: number;
  failedStageName?: string;
  /** Backend asked for clarification: AI-native copy instead of blocked copy. */
  clarification?: boolean;
  onRetry: () => void;
  onReturnToCommandCenter: () => void;
  /**
   * Clarification continuation: when provided (live mission only), the card
   * renders an inline amend-and-continue editor instead of sending the user
   * back to Command Center. The amended full request resumes the SAME mission.
   */
  onContinueMission?: (amendedPrompt: string) => void;
}

/**
 * NOTE: product support is backend-owned and explained in the backend's own
 * error message above. No frontend product list is kept here: a hardcoded
 * list would go stale and mislead residents.
 */

/**
 * Minimal safe renderer for model-authored narration. Supports only
 * `**bold**` and `` `code` `` spans; everything else stays plain text.
 * Output is React elements (never an HTML string), so React escapes all
 * model content and arbitrary HTML/script can never execute.
 */
function renderRichText(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      parts.push(
        <strong key={key++} className="font-semibold text-relay-ink-900">
          {token.slice(2, -2)}
        </strong>
      );
    } else {
      parts.push(
        <code
          key={key++}
          className="rounded bg-relay-surface-sunken px-1 py-0.5 font-mono text-[0.9em] text-relay-ink-900"
        >
          {token.slice(1, -1)}
        </code>
      );
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

export function FailureExperienceCard({
  prompt,
  errorCode,
  errorMessage,
  errorDetail,
  failedStageIndex,
  failedStageName,
  clarification = false,
  onRetry,
  onReturnToCommandCenter,
  onContinueMission,
}: FailureExperienceCardProps) {
  const displayCode = errorCode || 'MISSION_FAILED';
  const canContinueInline = clarification && typeof onContinueMission === 'function';
  const [draft, setDraft] = useState(prompt);
  useEffect(() => {
    setDraft(prompt);
  }, [prompt]);
  const submittable = draft.trim().length > 0;

  return (
    <div
      className="rounded-lg border border-relay-danger-100 bg-white text-relay-ink-900 shadow-card overflow-hidden"
      role="alert"
      aria-live="assertive"
    >
      {/* Status header */}
      <div className="bg-relay-danger-50 border-b border-relay-danger-100 px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-relay-danger-600 text-white shrink-0">
              <AlertTriangle className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <p className="font-mono text-[11px] text-relay-danger-700">
                {clarification ? 'Clarification Required' : 'Autonomous Mission Blocked'}
              </p>
              <h2 className="text-lg sm:text-xl font-semibold tracking-tight text-relay-ink-900 mt-0.5">
                {clarification ? 'I need a little more information' : 'Mission Execution Halted'}
              </h2>
            </div>
          </div>
          <span className="font-mono text-xs font-medium text-relay-danger-700">
            {displayCode}
          </span>
        </div>
      </div>

      <div className="p-5 sm:p-6 space-y-5">
        {/* Stage Failure Attribution */}
        <div className="flex items-center gap-2 text-xs font-medium text-relay-ink-500">
          <span className="h-2 w-2 rounded-full bg-relay-danger-600" aria-hidden />
          <span>
            {failedStageIndex !== undefined && failedStageIndex >= 0
              ? `Stage ${String(failedStageIndex + 1).padStart(2, '0')}: ${failedStageName || 'Execution'} · FAILED`
              : failedStageName
                ? `${failedStageName} · FAILED`
                : 'Execution · FAILED'}
          </span>
        </div>

        {/* User Request Quote */}
        <div className="rounded-lg border border-relay-surface-border bg-relay-surface-sunken/60 p-4">
          <p className="text-xs font-medium text-relay-ink-500 mb-1">
            Original Resident Request
          </p>
          <p className="text-base sm:text-lg font-medium text-relay-ink-900 font-mono">
            “{prompt}”
          </p>
        </div>

        {/* Explanation Message */}
        <div className="space-y-2">
          <p className="text-sm sm:text-base text-relay-ink-700 leading-relaxed">
            {errorMessage
              ? renderRichText(errorMessage)
              : 'Relay could not map this request to a supported procurement product.'}
          </p>
          {errorDetail && (
            <p className="text-xs font-mono text-relay-ink-500 bg-relay-surface-sunken p-2.5 rounded-lg border border-relay-surface-border">
              {errorDetail}
            </p>
          )}
        </div>

        {/* No-substitution assurance (never names products: no hardcoded list) */}
        {clarification && (
          <div className="rounded-lg border border-relay-surface-border bg-relay-surface-sunken/60 p-4 space-y-3">
            <p className="text-xs text-relay-ink-500">
              Relay never substitutes a different product or guesses missing details — nothing was ordered, and no payment was made.
            </p>
          </div>
        )}

        {/* Clarification continuation: answer inline; the SAME mission resumes. */}
        {canContinueInline ? (
          <div className="pt-2 space-y-3 border-t border-relay-surface-border">
            <label
              htmlFor="clarification-continue"
              className="block text-sm font-semibold text-relay-ink-900"
            >
              Answer Relay&apos;s question — your mission continues from here
            </label>
            <p className="text-xs text-relay-ink-500">
              Add only the missing detail below. Everything Relay already understood is kept.
            </p>
            <textarea
              id="clarification-continue"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-relay-surface-border bg-white px-4 py-3 text-sm text-relay-ink-900 font-mono focus:outline-none focus:ring-2 focus:ring-relay-primary-600/40"
            />
            <div className="flex flex-wrap items-center justify-between gap-4">
              <Button
                variant="secondary"
                size="md"
                onClick={onReturnToCommandCenter}
                className="flex items-center gap-2"
              >
                <CornerDownLeft className="h-4 w-4" aria-hidden />
                Return to Command Center
              </Button>
              <Button
                variant="primary"
                size="md"
                disabled={!submittable}
                onClick={() => {
                  if (submittable && onContinueMission) onContinueMission(draft.trim());
                }}
                className="flex items-center gap-2 bg-relay-primary-600 hover:bg-relay-primary-700 text-white disabled:opacity-50"
              >
                Continue mission
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          </div>
        ) : (
          <div className="pt-2 flex flex-wrap items-center justify-between gap-4 border-t border-relay-surface-border">
            <Button
              variant="secondary"
              size="md"
              onClick={onReturnToCommandCenter}
              className="flex items-center gap-2"
            >
              <CornerDownLeft className="h-4 w-4" aria-hidden />
              Return to Command Center
            </Button>

            <Button
              variant="primary"
              size="md"
              onClick={onRetry}
              className="flex items-center gap-2 bg-relay-primary-600 hover:bg-relay-primary-700 text-white"
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              Edit & Retry Request
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

