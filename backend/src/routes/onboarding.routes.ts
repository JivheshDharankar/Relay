import { Router } from 'express';
import { onboardingController } from '../controllers/onboarding.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { createRateLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

// All onboarding endpoints require valid authenticated session
router.use(requireAuth);

router.get('/status', (req, res, next) =>
  onboardingController.getStatus(req, res, next)
);

router.post('/profile', createRateLimiter('PROFILE_MUTATION'), (req, res, next) =>
  onboardingController.submitProfile(req, res, next)
);

router.post('/address', createRateLimiter('ONBOARDING_MUTATION'), (req, res, next) =>
  onboardingController.submitAddress(req, res, next)
);

router.post('/society', createRateLimiter('ONBOARDING_MUTATION'), (req, res, next) =>
  onboardingController.submitSociety(req, res, next)
);

router.post('/verify-society', createRateLimiter('ONBOARDING_MUTATION'), (req, res, next) =>
  onboardingController.verifySociety(req, res, next)
);

router.post('/society/verify', createRateLimiter('ONBOARDING_MUTATION'), (req, res, next) =>
  onboardingController.verifySociety(req, res, next)
);

router.post('/payment-mandate', createRateLimiter('ONBOARDING_MUTATION'), (req, res, next) =>
  onboardingController.submitPaymentMandate(req, res, next)
);

export const onboardingRoutes = router;

