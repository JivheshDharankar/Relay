import { Request, Response, NextFunction } from 'express';
import { onboardingService } from '../identity/OnboardingService';
import { identityAuditService } from '../identity/IdentityAuditService';

export class OnboardingController {
  /**
   * GET /api/onboarding/status
   * Returns current onboarding step and prerequisites status. Resumable.
   */
  public async getStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const summary = await onboardingService.evaluateOnboardingState(req.user!.id);
      res.status(200).json({ success: true, data: summary });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/onboarding/profile
   * Step 1: Submits personal details & preferences.
   */
  public async submitProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const summary = await onboardingService.submitProfileStep(req.user!.id, req.body);
      identityAuditService.emit('PROFILE_CREATED', req.user!.id, {
        fullName: req.body.fullName,
        email: req.body.email,
      });

      res.status(200).json({ success: true, data: summary });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/onboarding/address
   * Step 2: Submits delivery address.
   */
  public async submitAddress(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const summary = await onboardingService.submitAddressStep(req.user!.id, req.body);
      identityAuditService.emit('ADDRESS_CREATED', req.user!.id, {
        city: req.body.city,
        postalCode: req.body.postalCode,
      });

      res.status(200).json({ success: true, data: summary });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/onboarding/society
   * Step 3: Selects society and submits tower/flat.
   */
  public async submitSociety(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const summary = await onboardingService.submitSocietyStep(req.user!.id, req.body);
      identityAuditService.emit('SOCIETY_MEMBERSHIP_CREATED', req.user!.id, {
        societyId: req.body.societyId,
        tower: req.body.tower,
      });

      res.status(200).json({ success: true, data: summary });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/onboarding/verify-society
   * Step 4: Confirms society membership verification.
   */
  public async verifySociety(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const summary = await onboardingService.verifySocietyStep(req.user!.id, req.body);
      identityAuditService.emit('SOCIETY_MEMBERSHIP_VERIFIED', req.user!.id);

      res.status(200).json({ success: true, data: summary });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/onboarding/payment-mandate
   * Step 5: Authorizes spending limits through authoritative Phase 7 MandateService.
   */
  public async submitPaymentMandate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const summary = await onboardingService.submitPaymentMandateStep(req.user!.id, req.body);
      identityAuditService.emit('PAYMENT_MANDATE_CREATED', req.user!.id, {
        spendingLimit: req.body.spendingLimit,
        currency: req.body.currency,
      });

      identityAuditService.emit('ONBOARDING_COMPLETED', req.user!.id, {
        residentId: summary.residentId,
      });

      res.status(200).json({ success: true, data: summary });
    } catch (err) {
      next(err);
    }
  }
}

export const onboardingController = new OnboardingController();

