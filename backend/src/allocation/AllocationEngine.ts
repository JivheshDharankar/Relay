import {
  roundQuantity,
  toDecimal,
} from '../domain/procurement/decimal';
import { attachDemandLineIds } from './demandLineKey';
import { ResidentDemand } from './types';
import { AllocationValidationError, validateQuantityConservation } from './validation';

export interface QuantityAllocationResultItem {
  residentOrderId: string;
  /**
   * Per-line demand key carried through from the source demand. Always
   * populated by the engine; optional only for backward compatibility
   * with previously constructed items.
   */
  demandLineId?: string;
  residentReference: string;
  requestedQuantity: number;
  allocatedQuantity: number;
}

export interface QuantityAllocationInput {
  residentDemands: ResidentDemand[];
  verifiedFulfilledQuantity: number;
  allowFractions?: boolean;
}

export class AllocationEngine {
  /**
   * Deterministically allocates verified fulfilled quantities across participating resident demands.
   *
   * Invariants strictly enforced:
   * 1. SUM(allocatedQuantity) == verifiedFulfilledQuantity (for full or partial allocations within requested bounds)
   * 2. allocatedQuantity <= requestedQuantity for every resident (no over-allocation)
   * 3. allocatedQuantity >= 0 for every resident (no negative quantities)
   * 4. Completely deterministic tie-breaking using stable residentOrderId sorting
   */
  public allocateQuantities(input: QuantityAllocationInput): QuantityAllocationResultItem[] {
    const { residentDemands: inputDemands, verifiedFulfilledQuantity, allowFractions = false } = input;
    // Resolve stable per-line keys up front so every allocation path below
    // joins quantities to the correct demand item for shared-order lines.
    const residentDemands = attachDemandLineIds(inputDemands);

    if (verifiedFulfilledQuantity < 0) {
      throw new AllocationValidationError([
        `INVALID_FULFILLED_QUANTITY: Verified fulfilled quantity cannot be negative (${verifiedFulfilledQuantity})`,
      ]);
    }

    if (residentDemands.length === 0) {
      if (verifiedFulfilledQuantity > 0) {
        throw new AllocationValidationError([
          `NO_RESIDENT_DEMANDS: Cannot allocate ${verifiedFulfilledQuantity} units with zero resident demands`,
        ]);
      }
      return [];
    }

    // Validate non-negative requested quantities
    for (const demand of residentDemands) {
      if (demand.requestedQuantity < 0) {
        throw new AllocationValidationError([
          `NEGATIVE_REQUESTED_QUANTITY: Resident '${demand.residentReference}' requested negative quantity (${demand.requestedQuantity})`,
        ]);
      }
    }

    const totalRequested = residentDemands.reduce(
      (sum, d) => sum + d.requestedQuantity,
      0
    );

    // Case 1: Zero fulfilled quantity
    if (verifiedFulfilledQuantity === 0) {
      return residentDemands.map((d) => ({
        residentOrderId: d.residentOrderId,
        demandLineId: d.demandLineId ?? d.residentOrderId,
        residentReference: d.residentReference,
        requestedQuantity: d.requestedQuantity,
        allocatedQuantity: 0,
      }));
    }

    // Case 2: Exact full fulfillment
    if (totalRequested === verifiedFulfilledQuantity) {
      return residentDemands.map((d) => ({
        residentOrderId: d.residentOrderId,
        demandLineId: d.demandLineId ?? d.residentOrderId,
        residentReference: d.residentReference,
        requestedQuantity: d.requestedQuantity,
        allocatedQuantity: d.requestedQuantity,
      }));
    }

    // Target allocatable quantity: cannot exceed totalRequested
    const allocatableTarget = Math.min(verifiedFulfilledQuantity, totalRequested);

    // Case 3: Partial fulfillment with integer whole units (Hamilton-Hare / Largest Remainder)
    if (!allowFractions) {
      return this.allocateWholeUnits(residentDemands, totalRequested, allocatableTarget);
    }

    // Case 4: Partial fulfillment with divisible fractional quantities
    return this.allocateFractionalUnits(residentDemands, totalRequested, allocatableTarget);
  }

  /**
   * Deterministic whole-unit allocation using Hamilton-Hare Largest Remainder algorithm.
   */
  private allocateWholeUnits(
    demands: ResidentDemand[],
    totalRequested: number,
    targetQuantity: number
  ): QuantityAllocationResultItem[] {
    interface QuotaItem {
      demand: ResidentDemand;
      demandLineId: string;
      exactQuota: number;
      base: number;
      remainder: number;
    }

    const items: QuotaItem[] = demands.map((demand) => {
      const exactQuota = (demand.requestedQuantity * targetQuantity) / totalRequested;
      const base = Math.floor(exactQuota);
      const remainder = exactQuota - base;
      return {
        demand,
        demandLineId: demand.demandLineId ?? demand.residentOrderId,
        exactQuota,
        base,
        remainder,
      };
    });

    const sumBase = items.reduce((sum, item) => sum + item.base, 0);
    let remainingUnits = targetQuantity - sumBase;

    // Stable sort: highest remainder first, tie-breaker: stable residentOrderId ascending
    const sorted = [...items].sort((a, b) => {
      const diff = b.remainder - a.remainder;
      if (Math.abs(diff) > 1e-9) {
        return diff;
      }
      return a.demand.residentOrderId.localeCompare(b.demand.residentOrderId);
    });

    // Largest-remainder extras are tracked per demand line so shared-order
    // lines each receive at most one extra unit. Tie-breaking order is
    // unchanged (stable `residentOrderId` sort above).
    const extraMap = new Map<string, number>();
    for (let i = 0; i < sorted.length && remainingUnits > 0; i++) {
      extraMap.set(sorted[i].demandLineId, 1);
      remainingUnits--;
    }

    const itemByLineId = new Map<string, QuotaItem>(items.map((it) => [it.demandLineId, it]));
    const results: QuantityAllocationResultItem[] = demands.map((demand) => {
      const demandLineId = demand.demandLineId ?? demand.residentOrderId;
      const item = itemByLineId.get(demandLineId)!;
      const extra = extraMap.get(demandLineId) || 0;
      const allocatedQuantity = Math.min(item.base + extra, demand.requestedQuantity);
      return {
        residentOrderId: demand.residentOrderId,
        demandLineId,
        residentReference: demand.residentReference,
        requestedQuantity: demand.requestedQuantity,
        allocatedQuantity,
      };
    });

    // Invariant check
    const allocatedTotal = results.reduce((sum, r) => sum + r.allocatedQuantity, 0);
    validateQuantityConservation(allocatedTotal, targetQuantity);

    return results;
  }

  /**
   * Deterministic fractional unit allocation using exact Decimal precision.
   */
  private allocateFractionalUnits(
    demands: ResidentDemand[],
    totalRequested: number,
    targetQuantity: number
  ): QuantityAllocationResultItem[] {
    const decTarget = toDecimal(targetQuantity);
    const decTotalReq = toDecimal(totalRequested);

    const preliminary = demands.map((demand) => {
      const decReq = toDecimal(demand.requestedQuantity);
      const rawShare = decReq.times(decTarget).dividedBy(decTotalReq);
      const allocatedQuantity = roundQuantity(rawShare);
      return {
        demand,
        allocatedDecimal: allocatedQuantity,
      };
    });

    const sumAllocated = preliminary.reduce(
      (acc, item) => acc.plus(item.allocatedDecimal),
      toDecimal(0)
    );

    const diff = decTarget.minus(sumAllocated);

    // Apply residual difference to the resident with largest requested demand
    // Tie-breaker: stable residentOrderId
    if (!diff.isZero()) {
      const sorted = [...preliminary].sort((a, b) => {
        const reqDiff = b.demand.requestedQuantity - a.demand.requestedQuantity;
        if (Math.abs(reqDiff) > 1e-9) return reqDiff;
        return a.demand.residentOrderId.localeCompare(b.demand.residentOrderId);
      });
      sorted[0].allocatedDecimal = roundQuantity(sorted[0].allocatedDecimal.plus(diff));
    }

    const results: QuantityAllocationResultItem[] = preliminary.map((item) => ({
      residentOrderId: item.demand.residentOrderId,
      demandLineId: item.demand.demandLineId ?? item.demand.residentOrderId,
      residentReference: item.demand.residentReference,
      requestedQuantity: item.demand.requestedQuantity,
      allocatedQuantity: item.allocatedDecimal.toNumber(),
    }));

    const finalSum = results.reduce((acc, r) => acc + r.allocatedQuantity, 0);
    validateQuantityConservation(finalSum, targetQuantity);

    return results;
  }
}

export const allocationEngine = new AllocationEngine();
