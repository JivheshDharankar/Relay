import { describe, expect, it } from 'vitest';
import { getRunIntelligence, getStageIntelligence, summarizeRunOutcome } from '@/lib/workflow/intelligence';
import { mapRunToStages } from '@/lib/workflow/stageEvidence';
import { IDLE_RUN, type ProcurementRun } from '@/lib/workflow/types';
import type { AgentRunResponse, AgentStep } from '@/types';

function step(name: string, result?: Record<string, unknown>): AgentStep {
  return {
    stepNumber: 1,
    thought: 'SECRET-CHAIN-OF-THOUGHT must never leak',
    toolCall: { id: `call-${name}`, name, arguments: {}, ...(result ? { result } : {}) },
    timestamp: new Date().toISOString(),
  };
}

function runWith(response: AgentRunResponse): ProcurementRun {
  return { ...IDLE_RUN, status: 'complete', prompt: 'sugar', agentResponse: response };
}

describe('Relay Intelligence (decision-level only, never chain-of-thought)', () => {
  it('returns no notes for a run without evidence', () => {
    expect(getRunIntelligence(IDLE_RUN)).toEqual([]);
    expect(getStageIntelligence('SELECT', IDLE_RUN)).toEqual([]);
  });

  it('derives an intent note from createRequest + mandate check', () => {
    const run = runWith({
      success: true,
      completed: true,
      runId: 'r1',
      totalSteps: 2,
      response: 'ok',
      steps: [
        step('createRequest', { orderId: 'o1', productName: 'Sugar', quantity: 2, unit: 'kg' }),
        step('checkAuthorization', { requestedAmount: 500, maxAllowed: 10000 }),
      ],
    });
    const notes = getRunIntelligence(run);
    const intent = notes.find((n) => n.stage === 'UNDERSTAND');
    expect(intent).toBeDefined();
    expect(intent!.lines.join(' ')).toContain('Sugar');
    expect(JSON.stringify(notes)).not.toContain('SECRET-CHAIN-OF-THOUGHT');
  });

  it('reports mandate breach honestly when the estimate exceeds the ceiling', () => {
    const run = runWith({
      success: true,
      completed: true,
      runId: 'r2',
      totalSteps: 2,
      response: 'ok',
      steps: [
        step('createRequest', { orderId: 'o2', productName: 'Rice', quantity: 500, unit: 'kg' }),
        step('checkAuthorization', { requestedAmount: 42500, maxAllowed: 5000 }),
      ],
    });
    const notes = getRunIntelligence(run);
    const intent = notes.find((n) => n.stage === 'UNDERSTAND');
    expect(intent).toBeDefined();
    expect(intent!.lines.join(' ')).toContain('exceeds');
    expect(intent!.lines.join(' ')).not.toContain('cleared for autonomous execution');
  });

  it('summarizeRunOutcome counts stage states exactly', () => {
    const stages = mapRunToStages(IDLE_RUN);
    expect(summarizeRunOutcome(stages)).toEqual({ verified: 0, failed: 0, absent: 13 });
  });
});
