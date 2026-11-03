import type { AgentRunResponse } from '@/types';

export type ToolResult = Record<string, unknown>;

export function asRecord(value: unknown): ToolResult | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as ToolResult)
    : null;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** NEVER reads step.thought — chain-of-thought stays out of the view layer. */
export function findToolResult(
  response: AgentRunResponse | null,
  toolName: string
): ToolResult | null {
  for (const step of response?.steps ?? []) {
    if (step.toolCall?.name === toolName) {
      return asRecord(step.toolCall.result);
    }
  }
  return null;
}

/**
 * First NON-EMPTY result for a tool: exploratory calls that errored must not
 * shadow the later call that actually succeeded (the Meta loop routinely fails
 * a first attempt, then recovers).
 */
export function findSuccessfulToolResult(
  response: AgentRunResponse | null,
  toolName: string
): ToolResult | null {
  for (const step of response?.steps ?? []) {
    if (step.toolCall?.name !== toolName) continue;
    const result = asRecord(step.toolCall.result);
    if (result) return result;
  }
  return null;
}

/**
 * True when the run was driven by the workflow engine (Meta path) rather than
 * the direct mock tool chain: a successful startWorkflow is authoritative.
 */
export function hasWorkflowEngine(response: AgentRunResponse | null): boolean {
  const r = findSuccessfulToolResult(response, 'startWorkflow');
  return r !== null && r.success !== false;
}

export function toolErrorMessage(
  response: AgentRunResponse | null,
  toolName: string
): string | null {
  for (const step of response?.steps ?? []) {
    if (step.toolCall?.name === toolName && step.toolCall.error) {
      return (
        str((step.toolCall.error as Record<string, unknown>).message) ?? 'Tool call failed'
      );
    }
  }
  return null;
}
