import { Router } from 'express';
import { portalController } from '../controllers/portal.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { requireResidentOwnership } from '../middleware/authorization.middleware';

const router = Router();

// Resident profile (private: session-derived identity only)
router.get(
  '/resident',
  requireAuth,
  requireResidentOwnership(),
  (req, res, next) => portalController.getResident(req, res, next)
);

// Authenticated resident updates their own active mandate limit.
// Session-derived identity only; any client-supplied resident id that
// mismatches the session is rejected before the handler runs.
router.patch(
  '/mandate',
  requireAuth,
  requireResidentOwnership(),
  (req, res, next) => portalController.updateMandateLimit(req, res, next)
);

// Private resident orders (session-derived identity only)
router.get(
  '/orders',
  requireAuth,
  requireResidentOwnership(),
  (req, res, next) => portalController.getOrders(req, res, next)
);

// Community overview & demand pooling
router.get('/community', (req, res, next) => portalController.getCommunity(req, res, next));

// Mandates & payment transactions (private: session-derived identity only)
router.get(
  '/payments',
  requireAuth,
  requireResidentOwnership(),
  (req, res, next) => portalController.getPayments(req, res, next)
);

// Verified suppliers
router.get('/suppliers', (req, res, next) => portalController.getSuppliers(req, res, next));

export const portalRoutes = router;

