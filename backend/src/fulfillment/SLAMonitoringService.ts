import { randomUUID } from 'crypto';
import { eventBus } from '../events';
import { FulfillmentOrder, SLACalculationResult, SLAStatus } from './types';

export interface SLAPolicyConfig {
  defaultSlaHours: number;
  warningThresholdMinutes: number;
}

export class SLAMonitoringService {
  private config: SLAPolicyConfig;
  private warnedOrders = new Set<string>();
  private breachedOrders = new Set<string>();

  constructor(config?: Partial<SLAPolicyConfig>) {
    this.config = {
      defaultSlaHours: config?.defaultSlaHours ?? 12,
      warningThresholdMinutes: config?.warningThresholdMinutes ?? 120, // 2-hour warning
    };
  }

  /**
   * Calculates the authoritative SLA deadline from creation time and configured SLA window.
   */
  public computeDefaultDeadline(createdAt: Date = new Date()): Date {
    return new Date(createdAt.getTime() + this.config.defaultSlaHours * 3600 * 1000);
  }

  /**
   * Deterministically calculates current SLA status, remaining turnaround, and breach duration.
   */
  public calculateSLAStatus(
    order: FulfillmentOrder,
    referenceTime: Date = new Date()
  ): SLACalculationResult {
    const deadlineTime = order.slaDeadline.getTime();
    const nowTime = referenceTime.getTime();

    if (nowTime > deadlineTime) {
      const breachDurationMinutes = Math.max(
        1,
        Math.floor((nowTime - deadlineTime) / (60 * 1000))
      );
      return {
        slaDeadline: order.slaDeadline,
        remainingMinutes: 0,
        isOverdue: true,
        isBreached: true,
        breachDurationMinutes,
        slaStatus: 'BREACHED',
      };
    }

    const remainingMinutes = Math.floor((deadlineTime - nowTime) / (60 * 1000));
    let slaStatus: SLAStatus = 'ON_TRACK';

    if (remainingMinutes <= this.config.warningThresholdMinutes) {
      slaStatus = 'AT_RISK';
    }

    return {
      slaDeadline: order.slaDeadline,
      remainingMinutes,
      isOverdue: false,
      isBreached: false,
      breachDurationMinutes: 0,
      slaStatus,
    };
  }

  /**
   * Evaluates order SLA, updates order entity status, and emits warning or breach audit events.
   */
  public evaluateAndUpdateSLA(
    order: FulfillmentOrder,
    referenceTime: Date = new Date()
  ): SLACalculationResult {
    const result = this.calculateSLAStatus(order, referenceTime);
    order.slaStatus = result.slaStatus;

    if (result.slaStatus === 'AT_RISK' && !this.warnedOrders.has(order.id)) {
      this.warnedOrders.add(order.id);
      this.emitAuditEvent('SLA_WARNING', order.id, {
        slaDeadline: order.slaDeadline.toISOString(),
        remainingMinutes: result.remainingMinutes,
        warningThresholdMinutes: this.config.warningThresholdMinutes,
        supplierId: order.supplierId,
      });
    }

    if (result.slaStatus === 'BREACHED' && !this.breachedOrders.has(order.id)) {
      this.breachedOrders.add(order.id);
      this.emitAuditEvent('SLA_BREACHED', order.id, {
        slaDeadline: order.slaDeadline.toISOString(),
        breachDurationMinutes: result.breachDurationMinutes,
        supplierId: order.supplierId,
        fulfillmentStatus: order.status,
      });
    }

    return result;
  }

  public reset(): void {
    this.warnedOrders.clear();
    this.breachedOrders.clear();
  }

  private emitAuditEvent(
    eventType: 'SLA_WARNING' | 'SLA_BREACHED',
    aggregateId: string,
    payload: Record<string, unknown>
  ): void {
    eventBus
      .publish({
        id: randomUUID(),
        name: eventType,
        aggregateId,
        timestamp: new Date().toISOString(),
        payload,
      })
      .catch(() => {});
  }
}

export const slaMonitoringService = new SLAMonitoringService();

