import {
  ProcurementCommitmentService,
  procurementCommitmentService,
} from '../discovery/supplier/selection/ProcurementCommitmentService';
import {
  PurchaseOrderService,
  purchaseOrderService,
} from '../discovery/supplier/selection/PurchaseOrderService';
import { PaymentService, paymentService } from '../payment/PaymentService';
import { DeliveryTrackingService, deliveryTrackingService } from './DeliveryTrackingService';
import {
  FulfillmentEventService,
  fulfillmentEventService,
  IngestEventResult,
} from './FulfillmentEventService';
import {
  FulfillmentOrderService,
  fulfillmentOrderService,
} from './FulfillmentOrderService';
import { SLAMonitoringService, slaMonitoringService } from './SLAMonitoringService';
import {
  AggregateProcurementFulfillmentSummary,
  DeliveryTrackingResult,
  FulfillmentOrder,
  FulfillmentType,
  SLACalculationResult,
  SupplierFulfillmentEvent,
  VerificationEvidence,
} from './types';

export interface CreateFulfillmentForCommitmentInput {
  commitmentId: string;
  fulfillmentType?: FulfillmentType;
  deliveryArea?: string;
  slaDeadline?: Date;
}

export class FulfillmentService {
  constructor(
    private readonly commitmentSvc: ProcurementCommitmentService = procurementCommitmentService,
    private readonly poSvc: PurchaseOrderService = purchaseOrderService,
    private readonly paymentSvc: PaymentService = paymentService,
    private readonly orderSvc: FulfillmentOrderService = fulfillmentOrderService,
    private readonly eventSvc: FulfillmentEventService = fulfillmentEventService,
    private readonly slaSvc: SLAMonitoringService = slaMonitoringService,
    private readonly trackingSvc: DeliveryTrackingService = deliveryTrackingService
  ) {}

  /**
   * Deterministically creates independent fulfillment orders for each paid supplier purchase order
   * within a Phase 6 procurement commitment.
   */
  public async createFulfillmentForCommitment(
    input: CreateFulfillmentForCommitmentInput
  ): Promise<{
    orders: FulfillmentOrder[];
    summary: AggregateProcurementFulfillmentSummary;
  }> {
    const commitment = this.commitmentSvc.getCommitment(input.commitmentId);
    if (!commitment) {
      throw new Error(`Procurement commitment '${input.commitmentId}' not found`);
    }

    const purchaseOrders = this.poSvc.getPurchaseOrdersForCommitment(commitment.id);
    if (purchaseOrders.length === 0) {
      throw new Error(`No purchase orders found for commitment '${commitment.id}'`);
    }

    const payments = this.paymentSvc.getPaymentsForCommitment(commitment.id);
    const successfulPayments = payments.filter((p) => p.status === 'SUCCEEDED');

    if (successfulPayments.length === 0) {
      throw new Error(
        `Cannot fulfill commitment '${commitment.id}': No successful payments found`
      );
    }

    const createdOrders: FulfillmentOrder[] = [];

    // Create independent fulfillment orders per supplier PO
    for (const po of purchaseOrders) {
      const payment = successfulPayments.find((p) => p.purchaseOrderId === po.id);
      if (!payment) {
        continue;
      }

      const order = this.orderSvc.createFulfillmentOrder({
        commitment,
        purchaseOrder: po,
        payment,
        fulfillmentType: input.fulfillmentType,
        deliveryArea: input.deliveryArea,
        slaDeadline: input.slaDeadline,
      });

      createdOrders.push(order);
    }

    const summary = this.getAggregateFulfillmentSummary(commitment.id);
    return { orders: createdOrders, summary };
  }

  /**
   * Ingests, validates, and applies an incoming supplier operational event.
   */
  public async ingestSupplierEvent(
    event: SupplierFulfillmentEvent
  ): Promise<IngestEventResult> {
    const order = this.orderSvc.getFulfillmentOrder(event.fulfillmentId);
    if (!order) {
      throw new Error(`FulfillmentOrder '${event.fulfillmentId}' not found`);
    }

    const result = await this.eventSvc.ingestEvent(order, event);

    // Update real-time SLA metrics
    this.slaSvc.evaluateAndUpdateSLA(result.order);

    return result;
  }

  /**
   * Verifies delivery or service completion evidence.
   */
  public verifyFulfillment(
    fulfillmentId: string,
    evidence: VerificationEvidence
  ): FulfillmentOrder {
    return this.orderSvc.verifyFulfillment(fulfillmentId, evidence);
  }

  /**
   * Evaluates order SLA status against current or specified reference time.
   */
  public checkSLA(
    fulfillmentId: string,
    referenceTime: Date = new Date()
  ): SLACalculationResult {
    const order = this.orderSvc.getFulfillmentOrder(fulfillmentId);
    if (!order) {
      throw new Error(`FulfillmentOrder '${fulfillmentId}' not found`);
    }
    return this.slaSvc.evaluateAndUpdateSLA(order, referenceTime);
  }

  /**
   * Queries logistics tracking details from tracking provider.
   */
  public async getTracking(fulfillmentId: string): Promise<DeliveryTrackingResult> {
    const order = this.orderSvc.getFulfillmentOrder(fulfillmentId);
    if (!order) {
      throw new Error(`FulfillmentOrder '${fulfillmentId}' not found`);
    }
    if (!order.trackingReference) {
      throw new Error(`FulfillmentOrder '${fulfillmentId}' has no tracking reference`);
    }

    return this.trackingSvc.getTrackingStatus(order.trackingReference);
  }

  public getFulfillment(id: string): FulfillmentOrder | undefined {
    return this.orderSvc.getFulfillmentOrder(id);
  }

  public getFulfillmentsForCommitment(commitmentId: string): FulfillmentOrder[] {
    return this.orderSvc.getFulfillmentsForCommitment(commitmentId);
  }

  /**
   * Deterministically calculates aggregate multi-supplier fulfillment progress.
   */
  public getAggregateFulfillmentSummary(
    commitmentId: string
  ): AggregateProcurementFulfillmentSummary {
    const orders = this.orderSvc.getFulfillmentsForCommitment(commitmentId);

    const totalOrders = orders.length;
    const verifiedOrders = orders.filter((o) => o.status === 'VERIFIED').length;
    const failedOrders = orders.filter(
      (o) => o.status === 'FAILED' || o.status === 'REJECTED'
    ).length;
    const activeOrders = orders.filter(
      (o) =>
        o.status !== 'VERIFIED' &&
        o.status !== 'FAILED' &&
        o.status !== 'REJECTED' &&
        o.status !== 'CANCELLED'
    ).length;

    const hasPartial = orders.some(
      (o) =>
        o.fulfilledQuantity > 0 &&
        o.fulfilledQuantity < o.requestedQuantity
    );
    const hasDelayed = orders.some((o) => o.slaStatus === 'BREACHED');

    let overallStatus: AggregateProcurementFulfillmentSummary['status'] = 'NOT_STARTED';

    if (totalOrders > 0 && verifiedOrders === totalOrders) {
      overallStatus = 'ALL_VERIFIED';
    } else if (hasPartial) {
      overallStatus = 'PARTIALLY_FULFILLED';
    } else if (hasDelayed) {
      overallStatus = 'DELAYED';
    } else if (failedOrders > 0 && verifiedOrders === 0 && activeOrders === 0) {
      overallStatus = 'FAILED';
    } else if (activeOrders > 0) {
      overallStatus = 'IN_PROGRESS';
    }

    return {
      commitmentId,
      status: overallStatus,
      totalOrders,
      verifiedOrders,
      failedOrders,
      activeOrders,
      orders,
    };
  }

  public reset(): void {
    this.orderSvc.reset();
    this.eventSvc.reset();
    this.slaSvc.reset();
    this.trackingSvc.reset();
  }
}

export const fulfillmentService = new FulfillmentService();

