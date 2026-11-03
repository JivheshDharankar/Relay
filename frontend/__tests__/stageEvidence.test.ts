import { describe, expect, it } from 'vitest';
import { mapRunToStages, CANONICAL_STAGES } from '@/lib/workflow/stageEvidence';
import type { ProcurementRun } from '@/lib/workflow/types';
import type { AgentRunResponse, AgentStep } from '@/types';

function step(name: string, result?: Record<string, unknown>, error?: { code: string; message: string }): AgentStep {
  return {
    stepNumber: 1,
    thought: 'SECRET-CHAIN-OF-THOUGHT must never leak',
    toolCall: { id: `call-${name}`, name, arguments: {}, ...(result ? { result } : {}), ...(error ? { error } : {}) },
    timestamp: new Date().toISOString(),
  };
}

function response(steps: AgentStep[]): AgentRunResponse {
  return { success: true, completed: true, runId: 'run-test', totalSteps: steps.length, response: 'done', steps };
}

function run(partial: Partial<ProcurementRun> = {}): ProcurementRun {
  return {
    status: 'complete',
    prompt: '2 toothbrushes',
    agentResponse: null,
    fullCycle: null,
    residentOrderId: null,
    communityOrderId: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    ...partial,
  };
}

describe('mapRunToStages', () => {
  it('always returns all 13 canonical stages in order', () => {
    const stages = mapRunToStages(run());
    expect(stages).toHaveLength(13);
    expect(stages.map((s) => s.stage)).toEqual(CANONICAL_STAGES.map((s) => s.stage));
  });

  it('marks every stage absent when the run has no evidence and has not completed', () => {
    const stages = mapRunToStages(run({ status: 'idle' }));
    for (const s of stages) {
      expect(s.state).toBe('absent');
      expect(s.source).toBeNull();
    }
  });

  it('verifies COMPLETE only from run-level completion state', () => {
    expect(mapRunToStages(run({ status: 'complete' })).find((s) => s.stage === 'COMPLETE')!.state).toBe('verified');
    const failed = mapRunToStages(
      run({ status: 'failed', error: { message: 'boom', code: 'E', timedOut: false, unauthorized: false } })
    ).find((s) => s.stage === 'COMPLETE')!;
    expect(failed.state).toBe('failed');
    expect(failed.summary).toContain('boom');
  });

  it('marks UNDERSTAND failed when createRequest errors', () => {
    const stages = mapRunToStages(
      run({ agentResponse: response([step('createRequest', undefined, { code: 'X', message: 'boom' })]) })
    );
    const understand = stages.find((s) => s.stage === 'UNDERSTAND')!;
    expect(understand.state).toBe('failed');
    expect(understand.summary).toContain('boom');
  });

  it('verifies UNDERSTAND from createRequest with mandate facts, never inventing stages', () => {
    const stages = mapRunToStages(
      run({
        agentResponse: response([
          step('createRequest', { orderId: 'ord-1', productName: 'Sugar', quantity: 2, unit: 'kg' }),
          step('checkAuthorization', { requestedAmount: 500, maxAllowed: 10000 }),
        ]),
      })
    );
    const understand = stages.find((s) => s.stage === 'UNDERSTAND')!;
    expect(understand.state).toBe('verified');
    expect(understand.source).toBe('createRequest');
    expect(understand.facts.length).toBeGreaterThan(0);
    // Unrelated stages stay absent — evidence-gated truthfulness.
    expect(stages.find((s) => s.stage === 'DISCOVER')!.state).toBe('absent');
    expect(stages.find((s) => s.stage === 'PAY')!.state).toBe('absent');
  });

  it('never leaks chain-of-thought into summaries or facts', () => {
    const stages = mapRunToStages(
      run({
        agentResponse: response([
          step('createRequest', { orderId: 'ord-9', productName: 'Sugar', quantity: 1, unit: 'kg' }),
        ]),
      })
    );
    const blob = JSON.stringify(stages);
    expect(blob).not.toContain('SECRET-CHAIN-OF-THOUGHT');
  });

  it('marks UNDERSTAND blocked (not verified, not silent) when the run stopped before any tool ran', () => {
    // Shape of an UNMAPPABLE_PRODUCT run: failed, agent stopped with a
    // content-only step — zero tool calls, honest message in response.
    const honest = 'Relay understood your request ("I need 2 icecream"), but no matching procurement product exists in the current catalog.';
    const agentResponse: AgentRunResponse = {
      success: false,
      completed: true,
      runId: 'run-blocked',
      totalSteps: 1,
      response: honest,
      steps: [{ stepNumber: 1, thought: 'unmappable stop', timestamp: new Date().toISOString() }],
    };
    const stages = mapRunToStages(
      run({
        status: 'failed',
        prompt: 'I need 2 icecream',
        agentResponse,
        error: { message: honest, code: 'NO_TOOL_CALLS', timedOut: false, unauthorized: false },
      })
    );
    const understand = stages.find((s) => s.stage === 'UNDERSTAND')!;
    expect(understand.state).toBe('failed');
    expect(understand.summary).toContain('no matching procurement product');
    expect(JSON.stringify(stages)).not.toContain('Sunflower');
    // Nothing downstream may verify: no proof, payment, quotes, or completion.
    for (const s of stages) {
      if (s.stage === 'UNDERSTAND' || s.stage === 'COMPLETE') continue;
      expect(s.state).toBe('absent');
    }
    expect(stages.find((s) => s.stage === 'COMPLETE')!.state).toBe('failed');
  });

  it('keeps a legit mapped run verified even after an unrelated blocked run shape exists', () => {
    // Guard against shared-state contamination at the mapping layer: a normal
    // createRequest run must still verify UNDERSTAND from its own evidence.
    const stages = mapRunToStages(
      run({
        agentResponse: response([
          step('createRequest', { orderId: 'ord-7', productName: 'Cold-Pressed Sunflower Cooking Oil', quantity: 5, unit: 'LITRE' }),
        ]),
      })
    );
    const understand = stages.find((s) => s.stage === 'UNDERSTAND')!;
    expect(understand.state).toBe('verified');
    expect(understand.summary).toContain('Sunflower');
  });
});
