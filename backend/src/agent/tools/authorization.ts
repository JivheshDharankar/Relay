import { ToolExecutionError } from './registry';
import { ToolExecutionContext } from './types';

/**
 * Server-side authorization guards for agent tools.
 *
 * The model supplies tool ARGUMENTS; it never supplies identity. Every guard
 * below binds the tool's target to the server-resolved ToolExecutionContext
 * (session resident/society). Model-echoed identity fields must match the
 * context exactly or the tool fails closed — the same precedent as
 * startWorkflow's IDENTITY_REFERENCE_MISMATCH.
 */

/**
 * Requires a server execution context carrying a resident identity.
 */
export function requireToolContext(
  ctx: ToolExecutionContext | undefined,
  toolName: string
): ToolExecutionContext {
  if (!ctx || !ctx.residentId) {
    throw new ToolExecutionError(
      'MISSING_EXECUTION_CONTEXT',
      `Tool '${toolName}' rejected: execution context with residentId is required.`
    );
  }
  return ctx;
}

/**
 * Requires a model-echoed resident reference to exactly match the context
 * resident. The echo exists for wire compatibility; the context is authority.
 */
export function requireContextResidentEcho(
  ctx: ToolExecutionContext,
  claimedResidentReference: unknown,
  toolName: string
): void {
  if (claimedResidentReference !== ctx.residentId) {
    throw new ToolExecutionError(
      'IDENTITY_REFERENCE_MISMATCH',
      `Tool '${toolName}' rejected: resident reference must exactly match the authenticated execution context.`
    );
  }
}

/**
 * Requires the target resident to be the context resident (private reads).
 */
export function requireSelfResident(
  ctx: ToolExecutionContext,
  targetResidentReference: unknown,
  toolName: string
): void {
  if (targetResidentReference !== ctx.residentId) {
    throw new ToolExecutionError(
      'CROSS_RESIDENT_ACCESS_DENIED',
      `Tool '${toolName}' rejected: cannot access another resident's records.`
    );
  }
}

/**
 * Requires a commitment-scoped record to belong to the context society when
 * the record carries a society id. Records without one skip this check
 * (society unknown) — payment/allocation records additionally bind the payer.
 */
export function requireCommitmentSociety(
  ctx: ToolExecutionContext,
  commitmentSocietyId: string | undefined,
  toolName: string
): void {
  if (
    commitmentSocietyId !== undefined &&
    ctx.societyId !== undefined &&
    commitmentSocietyId !== ctx.societyId
  ) {
    throw new ToolExecutionError(
      'CROSS_SOCIETY_ACCESS_DENIED',
      `Tool '${toolName}' rejected: commitment belongs to another society.`
    );
  }
}

/**
 * Requires a workflow to belong to the context resident and society.
 */
export function requireWorkflowOwnership(
  ctx: ToolExecutionContext,
  workflow: { residentReference: string; societyReference: string },
  toolName: string
): void {
  if (
    workflow.residentReference !== ctx.residentId ||
    workflow.societyReference !== ctx.societyId
  ) {
    throw new ToolExecutionError(
      'CROSS_RESIDENT_ACCESS_DENIED',
      `Tool '${toolName}' rejected: workflow belongs to another resident or society.`
    );
  }
}

/**
 * Requires a mandate/payer owner reference to be the context resident.
 */
export function requireMandateOwner(
  ctx: ToolExecutionContext,
  mandateOwnerReference: string | undefined,
  toolName: string,
  what: string
): void {
  if (mandateOwnerReference !== ctx.residentId) {
    throw new ToolExecutionError(
      'CROSS_RESIDENT_ACCESS_DENIED',
      `Tool '${toolName}' rejected: ${what} belongs to another resident.`
    );
  }
}
