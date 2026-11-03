import { IntentExtractor, toParsedResidentIntents } from './intentExtractor';
import type { IntentIssue, ValidatedIntent } from './intentExtractor';
import { getModelProvider } from '../model';
import type { ModelProvider } from '../model';
import { ToolExecutionError } from '../tools/registry';

/**
 * One deterministically resolved procurement line item.
 *
 * Produced ONLY from the Phase 14.2 validated stack: the model proposes a
 * decomposition, strict zod validation applies, then every item is resolved
 * against INTENT_CATALOG. Product identity (productId + canonical name)
 * always comes from the catalog — never from model-supplied identifiers.
 */
export interface ResolvedWorkflowItem {
  productId: string | null;
  productName: string;
  quantity: number;
  unit: string;
  identitySource: 'catalog' | 'open-world';
  /** Verbatim stated semantic cues; descriptive evidence only. */
  brand?: string;
  packaging?: string;
  packSize?: string;
  priceCue?: string;
  variant?: string;
}

/**
 * Resolves a resident natural-language request into validated workflow line
 * items through the existing 14.2 intent stack (IntentExtractor +
 * toParsedResidentIntents bridge + deterministic catalog matching).
 *
 * Fail-closed gate for the real workflow-engine entry path:
 * - every item must resolve: catalog match yields a canonical product ID,
 *   anything else validated yields an open-world item with NO product ID
 * - ANY unresolvable item fails the WHOLE request (no partial procurement)
 * - model-supplied product IDs are never trusted (catalog or null only)
 * - provider failures fail closed (no workflow is created by the caller)
 *
 * Throws ToolExecutionError with a classified code. Callers must invoke this
 * BEFORE creating any workflow state, discovery, quote, commitment, or
 * payment. Single-item requests resolve to a one-element array.
 */
export async function resolveWorkflowItems(
  requestText: string,
  provider?: ModelProvider
): Promise<ResolvedWorkflowItem[]> {
  const resolved = await resolveWorkflowRequest(requestText, provider);
  return resolved.items;
}

/**
 * Builds targeted-clarification details for a refused request: the resolved
 * items (preserved verbatim so the agent never re-asks them) plus exactly
 * which items are unresolved and why. Procurement still refuses to start —
 * details only make the follow-up question precise.
 */
function buildClarificationDetails(
  intent: ValidatedIntent | undefined,
  issues: IntentIssue[]
): Record<string, unknown> {
  if (!intent) {
    return { resolvedItems: [], unresolvedItems: [], issues };
  }
  const resolvedItems = toParsedResidentIntents(intent);
  const unresolvedItems = intent.items
    .map((item, itemIndex) => ({ item, itemIndex }))
    .filter(({ item }) => item.resolution.status !== 'resolved')
    .map(({ item, itemIndex }) => ({
      itemIndex,
      productName: item.productName,
      quantity: item.quantity ?? null,
      unit: item.unit ?? null,
      code:
        item.resolution.status === 'unresolved'
          ? item.resolution.reason
          : 'UNRESOLVED_ITEM',
      message: issues.find((issue) => issue.itemIndex === itemIndex)?.message ?? null,
    }));
  return { resolvedItems, unresolvedItems, issues };
}

/**
 * Entry-gate twin of resolveWorkflowItems that additionally surfaces the
 * validated user-stated deadline (when the request named one) so the
 * workflow can record requested-vs-guaranteed SLA honestly. Same
 * fail-closed contract; the deadline is validated intent data, never a
 * new procurement behavior.
 */
export async function resolveWorkflowRequest(
  requestText: string,
  provider?: ModelProvider
): Promise<{ items: ResolvedWorkflowItem[]; deadlineHours?: number }> {
  const extractor = new IntentExtractor({
    provider: provider ?? getModelProvider(),
  });
  const result = await extractor.extract(requestText);

  if (result.status === 'ok' && result.intent) {
    const parsed = toParsedResidentIntents(result.intent);
    // 'ok' means zero validation issues: every proposed item resolved, so
    // the bridge must preserve the full item list. Any divergence fails
    // closed rather than risking a silently dropped line item.
    if (parsed.length !== result.intent.items.length || parsed.length === 0) {
      throw new ToolExecutionError(
        'INTENT_RESOLUTION_MISMATCH',
        'Intent decomposition produced an inconsistent resolved-item list; refusing to start procurement.'
      );
    }
    const items = result.intent.items.map((item, index) => {
      const resolution = item.resolution;
      if (
        resolution.status !== 'resolved' ||
        item.quantity === undefined ||
        item.unit === undefined
      ) {
        throw new ToolExecutionError(
          'INTENT_RESOLUTION_MISMATCH',
          `Intent item ${index} is not fully resolved; refusing to start procurement.`
        );
      }
      const parsedItem = parsed[index];
      return {
        productId: resolution.productId,
        productName: parsedItem.productName,
        quantity: parsedItem.quantity,
        unit: parsedItem.unit,
        identitySource: resolution.identitySource,
        ...(parsedItem.brand !== undefined ? { brand: parsedItem.brand } : {}),
        ...(parsedItem.packaging !== undefined ? { packaging: parsedItem.packaging } : {}),
        ...(parsedItem.packSize !== undefined ? { packSize: parsedItem.packSize } : {}),
        ...(parsedItem.priceCue !== undefined ? { priceCue: parsedItem.priceCue } : {}),
        ...(parsedItem.variant !== undefined ? { variant: parsedItem.variant } : {}),
      };
    });
    const deadlineHours = result.intent.deadline?.maxHours;
    return deadlineHours === undefined ? { items } : { items, deadlineHours };
  }

  const issues = result.issues ?? [];
  const details = buildClarificationDetails(result.intent, issues);
  const unmappable = issues.find((i) => i.code === 'UNMAPPABLE_PRODUCT');
  if (unmappable) {
    throw new ToolExecutionError(
      'UNMAPPABLE_PRODUCT',
      `I need a little more information — refusing to start procurement. ${unmappable.message}`,
      details
    );
  }
  const first = issues[0];
  throw new ToolExecutionError(
    first?.code || 'INTENT_RESOLUTION_FAILED',
    `Could not resolve a valid procurement intent; refusing to start procurement. ${first?.message || 'Unknown intent failure.'}`,
    details
  );
}
