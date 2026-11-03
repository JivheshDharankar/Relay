import { Request, Response, NextFunction } from 'express';
import { societyService } from '../identity/SocietyService';
import { membershipService } from '../identity/MembershipService';

export class SocietyController {
  /**
   * GET /api/societies/search
   * Dynamic society search by query text, city, postal code, or geographic coordinates.
   */
  public async searchSocieties(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const societies = await societyService.searchSocieties({
        query: req.query.q as string,
        city: req.query.city as string,
        postalCode: req.query.postalCode as string,
        latitude: req.query.lat ? parseFloat(req.query.lat as string) : undefined,
        longitude: req.query.lng ? parseFloat(req.query.lng as string) : undefined,
        radiusKm: req.query.radius ? parseFloat(req.query.radius as string) : 15,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
      });

      res.status(200).json({ success: true, data: societies });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/societies
   * Registers a new society dynamically with PENDING_VERIFICATION status.
   */
  public async registerSociety(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const society = await societyService.registerSociety(req.body);
      res.status(201).json({ success: true, data: society });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/societies/:id
   * Retrieves public metadata for a specific society.
   */
  public async getSocietyById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const society = await societyService.getSocietyById(req.params.id);
      if (!society) {
        res.status(404).json({
          success: false,
          error: { code: 'SOCIETY_NOT_FOUND', message: `Society '${req.params.id}' not found` },
        });
        return;
      }

      res.status(200).json({ success: true, data: society });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/societies/:id/supplier-delivery-view
   * Strict privacy-safe community delivery location for suppliers.
   * Guarantees that flat numbers and resident names NEVER leak to suppliers!
   */
  public async getSupplierDeliveryView(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const view = await membershipService.getSupplierCommunityDeliveryView(req.params.id);
      res.status(200).json({ success: true, data: view });
    } catch (err) {
      next(err);
    }
  }
}

export const societyController = new SocietyController();

