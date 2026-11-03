import { ResidentDemand } from './types';

/**
 * Stable per-line demand identity for the allocation pipeline.
 *
 * A multi-item resident order produces one demand per line item, and every
 * line shares the same `residentOrderId`. Joining cost results back to
 * demands on `residentOrderId` alone therefore resolves every line to the
 * first demand (`.find()` returns the first match), which mislabels
 * allocation evidence with line-1's product name/unit.
 *
 * `demandLineId` is the deterministic per-line key threaded through
 * quantity allocation, cost allocation, and the final allocation records
 * so each allocation line joins to its own demand item:
 * - An explicit `demandLineId` supplied by the caller always wins.
 * - A demand whose `residentOrderId` is unique in the batch keeps that
 *   order ID as its line key, preserving legacy single-line behavior
 *   exactly (including idempotency-key strings).
 * - Lines sharing an order ID get a content-derived composite key
 *   (`orderId::productId::product-name-slug::unit::occurrence`). Array
 *   position is never the join mechanism; the occurrence counter only
 *   disambiguates lines with otherwise identical content.
 */
export function slugDemandToken(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'item';
}

export function resolveDemandLineIds(demands: ResidentDemand[]): string[] {
  const orderCounts = new Map<string, number>();
  for (const demand of demands) {
    orderCounts.set(demand.residentOrderId, (orderCounts.get(demand.residentOrderId) ?? 0) + 1);
  }

  const occurrences = new Map<string, number>();
  return demands.map((demand) => {
    if (demand.demandLineId && demand.demandLineId.length > 0) {
      return demand.demandLineId;
    }
    if ((orderCounts.get(demand.residentOrderId) ?? 0) <= 1) {
      return demand.residentOrderId;
    }
    const productPart =
      demand.productId && demand.productId.length > 0 ? demand.productId : 'open-world';
    const namePart = slugDemandToken(demand.productName);
    const unitPart =
      demand.unit && demand.unit.trim().length > 0 ? demand.unit.toLowerCase().trim() : 'unit';
    const base = `${demand.residentOrderId}::${productPart}::${namePart}::${unitPart}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return `${base}::${occurrence}`;
  });
}

/**
 * Returns demand entries with `demandLineId` populated. Entries that
 * already carry their resolved key are returned by reference; all other
 * entries are shallow-copied so caller arrays are never mutated.
 */
export function attachDemandLineIds(demands: ResidentDemand[]): ResidentDemand[] {
  const lineIds = resolveDemandLineIds(demands);
  return demands.map((demand, index) =>
    demand.demandLineId === lineIds[index]
      ? demand
      : { ...demand, demandLineId: lineIds[index] }
  );
}
