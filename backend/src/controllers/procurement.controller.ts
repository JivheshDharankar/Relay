import { Request, Response, NextFunction } from 'express';
import {
  requestService,
  authorizationService,
  aggregationService,
  offerService,
  orderService,
  reconciliationService,
} from '../services/procurement';

export class ProcurementController {
  public async validateRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = await requestService.validateRequest(req.body);
      res.status(200).json({ success: true, data: validated });
    } catch (err) {
      next(err);
    }
  }

  public async checkAuthorization(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authorizationService.checkAuthorization(req.body);
      res.status(result.authorized ? 200 : 403).json({ success: result.authorized, data: result });
    } catch (err) {
      next(err);
    }
  }

  public async aggregateDemand(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { societyId, orderIds } = req.body;
      const result = await aggregationService.aggregateSocietyDemand(societyId, orderIds);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  public async evaluateOffers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ranked = await offerService.evaluateOffers(req.body);
      res.status(200).json({ success: true, data: ranked });
    } catch (err) {
      next(err);
    }
  }

  public async createCommunityOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await orderService.createCommunityOrder({
        ...req.body,
        deliveryDeadline: new Date(req.body.deliveryDeadline),
      });
      res.status(result.isDuplicate ? 200 : 201).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  public async reconcileOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { communityOrderId } = req.body;
      const report = await reconciliationService.reconcileCommunityOrder(communityOrderId);
      res.status(report.isReconciled ? 200 : 422).json({ success: report.isReconciled, data: report });
    } catch (err) {
      next(err);
    }
  }
}

export const procurementController = new ProcurementController();

