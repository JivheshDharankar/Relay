import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { createRateLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

// =============================================================================
// Provider Discovery & Metadata
// =============================================================================
router.get('/providers', (req, res, next) =>
  authController.getProviders(req, res, next)
);

// =============================================================================
// Google OAuth 2.0 / OpenID Connect
// =============================================================================
router.get('/google', createRateLimiter('AUTH_ATTEMPT'), (req, res, next) =>
  authController.initiateGoogle(req, res, next)
);

router.get('/google/callback', createRateLimiter('AUTH_ATTEMPT'), (req, res, next) =>
  authController.handleGoogleCallback(req, res, next)
);

router.post('/oauth/exchange', createRateLimiter('AUTH_ATTEMPT'), (req, res, next) =>
  authController.exchangeOAuthGrant(req, res, next)
);

// =============================================================================
// Dedicated Email OTP
// =============================================================================
router.post('/email/request-otp', createRateLimiter('OTP_REQUEST'), (req, res, next) =>
  authController.requestEmailOtp(req, res, next)
);

router.post('/email/verify-otp', createRateLimiter('AUTH_ATTEMPT'), (req, res, next) =>
  authController.verifyEmailOtp(req, res, next)
);

// =============================================================================
// Dedicated Phone OTP
// =============================================================================
router.post('/phone/request-otp', createRateLimiter('OTP_REQUEST'), (req, res, next) =>
  authController.requestPhoneOtp(req, res, next)
);

router.post('/phone/verify-otp', createRateLimiter('AUTH_ATTEMPT'), (req, res, next) =>
  authController.verifyPhoneOtp(req, res, next)
);

// =============================================================================
// Legacy & Unified Endpoints (Maintained for Backward Compatibility)
// =============================================================================
router.post('/send-otp', createRateLimiter('OTP_REQUEST'), (req, res, next) =>
  authController.sendOtp(req, res, next)
);

router.post('/login', createRateLimiter('AUTH_ATTEMPT'), (req, res, next) =>
  authController.login(req, res, next)
);

router.get('/session', requireAuth, (req, res, next) =>
  authController.getSession(req, res, next)
);

router.post('/logout', (req, res, next) =>
  authController.logout(req, res, next)
);

export const authRoutes = router;
