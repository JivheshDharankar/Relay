'use client';

import { useCallback, useRef, useState } from 'react';
import { ApiClientError, executeFullCycle, runAgent } from '@/lib/api';
import type { AgentRunResponse } from '@/types';
import { IDLE_RUN, type FullCycleResult, type ProcurementRun, type RunError } from './types';

function toRunError(err: unknown): RunError {
  if (err instanceof ApiClientError) {
    return {
      message: err.message,
      code: err.code,
      detail:
        typeof err.details === 'string'
          ? err.details
          : err.details !== undefined
            ? JSON.stringify(err.details)
            : undefined,
      timedOut: err.code === 'TIMEOUT',
      unauthorized: err.status === 401 || err.status === 403,
    };
  }
  return {
    message: err instanceof Error ? err.message : 'Procurement run failed.',
    code: 'UNKNOWN',
    timedOut: false,
    unauthorized: false,
  };
}

function findToolResult(
  response: AgentRunResponse,
  toolName: string
): Record<string, unknown> | null {
  for (const step of response.steps ?? []) {
    if (step.toolCall?.name === toolName && step.toolCall.result) {
      return step.toolCall.result as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * Runs one autonomous procurement: agent orchestration first, then the
 * deterministic full-cycle fallback when the agent run did not itself settle
 * payment/delivery. Stores backend artifacts verbatim.
 */
export function useProcurementRun() {
  const [run, setRun] = useState<ProcurementRun>(IDLE_RUN);
  // Monotonic command sequence: a slow response from an older command must
  // never overwrite the UI state of a newer one.
  const seqRef = useRef(0);

  const start = useCallback(async (promptText: string) => {
    const prompt = promptText.trim();
    if (!prompt) return;

    seqRef.current += 1;
    const seq = seqRef.current;
    const isStale = () => seq !== seqRef.current;

    setRun({
      ...IDLE_RUN,
      status: 'processing',
      prompt,
      startedAt: new Date().toISOString(),
    });

    try {
      const agentResponse = await runAgent({ message: prompt });
      if (isStale()) return;

      if (!agentResponse.success) {
        setRun((prev) => ({
          ...prev,
          status: 'failed',
          agentResponse,
          finishedAt: new Date().toISOString(),
          error: {
            message:
              agentResponse.error?.message || 'Relay agent could not process this request.',
            code: agentResponse.error?.code || 'AGENT_FAILED',
            timedOut: false,
            unauthorized: false,
          },
        }));
        return;
      }

      const hasToolCalls = (agentResponse.steps ?? []).some((s) => Boolean(s.toolCall));
      if (!hasToolCalls) {
        setRun((prev) => ({
          ...prev,
          status: 'failed',
          agentResponse,
          finishedAt: new Date().toISOString(),
          error: {
            message:
              agentResponse.response ||
              'Relay could not map this request to the community supplier catalog.',
            code: 'NO_TOOL_CALLS',
            timedOut: false,
            unauthorized: false,
          },
        }));
        return;
      }

      const createResult = findToolResult(agentResponse, 'createRequest');
      const communityResult = findToolResult(agentResponse, 'createCommunityOrder');
      const paymentResult = findToolResult(agentResponse, 'requestPayment');

      const residentOrderId =
        typeof createResult?.orderId === 'string' ? createResult.orderId : null;
      const orderRef = communityResult?.order as Record<string, unknown> | undefined;
      const communityOrderId =
        typeof orderRef?.id === 'string' ? (orderRef.id as string) : null;

      let fullCycle: FullCycleResult | null = null;
      if (!paymentResult && communityOrderId) {
        setRun((prev) => ({
          ...prev,
          status: 'verifying',
          agentResponse,
          residentOrderId,
          communityOrderId,
        }));
        fullCycle = await executeFullCycle(communityOrderId);
        if (isStale()) return;
      }

      setRun((prev) => ({
        ...prev,
        status: 'complete',
        agentResponse,
        fullCycle,
        residentOrderId,
        communityOrderId,
        finishedAt: new Date().toISOString(),
      }));
    } catch (err) {
      if (isStale()) return;
      setRun((prev) => ({
        ...prev,
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: toRunError(err),
      }));
    }
  }, []);

  const reset = useCallback(() => {
    setRun(IDLE_RUN);
  }, []);

  return {
    run,
    start,
    reset,
    isProcessing: run.status === 'processing' || run.status === 'verifying',
    isComplete: run.status === 'complete',
    isFailed: run.status === 'failed',
    isIdle: run.status === 'idle',
  };
}
