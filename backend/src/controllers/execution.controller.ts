import { Request, Response, NextFunction } from 'express';
import { executionService, ExecutionError } from '../execution';
import { DeliverySimulatorError } from '../execution/delivery/DeliverySimulator';
import { DeliveryStatus } from '@prisma/client';

export class ExecutionController {
  /**
   * POST /api/execution/payment
   * Executes pre-authorized resident payment via PaymentAdapter.
   */
  public async executePayment(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { residentOrderId, paymentMandateId, amount, idempotencyKey, purpose } = req.body;

      if (!residentOrderId || typeof residentOrderId !== 'string') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: "Field 'residentOrderId' is required.",
          },
        });
        return;
      }

      const result = await executionService.executeResidentPayment({
        residentOrderId,
        paymentMandateId,
        amount: amount !== undefined ? Number(amount) : undefined,
        idempotencyKey,
        purpose,
        expectedResidentId: req.residentId,
      });

      res.status(200).json({ success: true, data: result });
    } catch (err) {
      if (err instanceof ExecutionError) {
        const statusCode = err.code === 'RESIDENT_ORDER_NOT_FOUND' ? 404 : 400;
        res.status(statusCode).json({
          success: false,
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
          },
        });
        return;
      }
      next(err);
    }
  }

  /**
   * POST /api/execution/supplier/order
   * Submits strictly anonymized bulk PO to winning supplier and confirms order.
   */
  public async executeSupplierPO(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { communityOrderId, idempotencyKey } = req.body;

      if (!communityOrderId || typeof communityOrderId !== 'string') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: "Field 'communityOrderId' is required.",
          },
        });
        return;
      }

      const result = await executionService.executeSupplierProcurement({
        communityOrderId,
        idempotencyKey,
      });

      res.status(200).json({ success: true, data: result });
    } catch (err) {
      if (err instanceof ExecutionError) {
        const statusCode = err.code === 'COMMUNITY_ORDER_NOT_FOUND' ? 404 : 400;
        res.status(statusCode).json({
          success: false,
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
          },
        });
        return;
      }
      next(err);
    }
  }

  /**
   * POST /api/execution/delivery/advance
   * Transitions delivery status through the deterministic state machine.
   */
  public async advanceDelivery(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { communityOrderId, targetStatus } = req.body;

      if (!communityOrderId || typeof communityOrderId !== 'string') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: "Field 'communityOrderId' is required.",
          },
        });
        return;
      }

      if (!targetStatus || !Object.values(DeliveryStatus).includes(targetStatus)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_STATUS',
            message: `Target status must be one of: ${Object.values(DeliveryStatus).join(', ')}`,
          },
        });
        return;
      }

      const result = await executionService.advanceCommunityDelivery(communityOrderId, targetStatus);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      if (err instanceof DeliverySimulatorError || err instanceof ExecutionError) {
        const statusCode = err.code === 'COMMUNITY_ORDER_NOT_FOUND' ? 404 : 400;
        res.status(statusCode).json({
          success: false,
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
          },
        });
        return;
      }
      next(err);
    }
  }

  /**
   * GET /api/execution/delivery/:communityOrderId
   * Retrieves current fulfillment and delivery snapshot.
   */
  public async getDeliveryStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { communityOrderId } = req.params;

      if (!communityOrderId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: "Param 'communityOrderId' is required.",
          },
        });
        return;
      }

      const snapshot = await executionService.getDeliveryStatus(communityOrderId);
      res.status(200).json({ success: true, data: snapshot });
    } catch (err) {
      if (err instanceof DeliverySimulatorError || err instanceof ExecutionError) {
        const statusCode = err.code === 'COMMUNITY_ORDER_NOT_FOUND' ? 404 : 400;
        res.status(statusCode).json({
          success: false,
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
          },
        });
        return;
      }
      next(err);
    }
  }

  /**
   * POST /api/execution/full-cycle
   * Coordinates the full end-to-end execution pipeline from payments to reconciliation.
   */
  public async executeFullCycle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { communityOrderId, allocations } = req.body;

      if (!communityOrderId || typeof communityOrderId !== 'string') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: "Field 'communityOrderId' is required.",
          },
        });
        return;
      }

      const result = await executionService.executeFullProcurementCycle({
        communityOrderId,
        allocations,
      });

      res.status(result.success ? 200 : 422).json({
        success: result.success,
        data: result,
      });
    } catch (err) {
      if (err instanceof ExecutionError || err instanceof DeliverySimulatorError) {
        const statusCode = err.code === 'COMMUNITY_ORDER_NOT_FOUND' ? 404 : 400;
        res.status(statusCode).json({
          success: false,
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
          },
        });
        return;
      }
      next(err);
    }
  }
}

export const executionController = new ExecutionController();

