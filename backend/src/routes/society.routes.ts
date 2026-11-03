import { Router } from 'express';
import { societyController } from '../controllers/society.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { createRateLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

router.get('/search', createRateLimiter('SOCIETY_SEARCH'), (req, res, next) =>
  societyController.searchSocieties(req, res, next)
);

// Society registration mutates the shared registry: authenticated callers
// only (onboarding always runs authenticated).
router.post('/', requireAuth, createRateLimiter('ONBOARDING_MUTATION'), (req, res, next) =>
  societyController.registerSociety(req, res, next)
);

router.post('/register', requireAuth, createRateLimiter('ONBOARDING_MUTATION'), (req, res, next) =>
  societyController.registerSociety(req, res, next)
);

router.get('/:id', (req, res, next) =>
  societyController.getSocietyById(req, res, next)
);

router.get('/:id/supplier-delivery-view', (req, res, next) =>
  societyController.getSupplierDeliveryView(req, res, next)
);

export const societyRoutes = router;

