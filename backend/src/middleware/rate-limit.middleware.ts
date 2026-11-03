import { Request, Response, NextFunction } from 'express';
import {
  rateLimiterService,
  DEFAULT_RATE_POLICIES,
  RateLimitPolicy,
} from '../identity/RateLimiterService';
import { identityAuditService } from '../identity/IdentityAuditService';

/**
 * Creates an Express rate-limiting middleware for sensitive endpoints.
 */
export function createRateLimiter(
  policyName: keyof typeof DEFAULT_RATE_POLICIES | string,
  customPolicy?: RateLimitPolicy
) {
  const policy = customPolicy || DEFAULT_RATE_POLICIES[policyName] || { maxRequests: 60, windowSeconds: 60 };

  return (req: Request, res: Response, next: NextFunction): void => {
    // Key guests by req.ip, which honors X-Forwarded-For ONLY when the app
    // explicitly trusts a reverse proxy (TRUST_PROXY). Raw XFF headers from
    // direct clients are never trusted, so limits cannot be evaded by
    // rotating a request header.
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const key = req.user ? `user:${req.user.id}:${policyName}` : `ip:${clientIp}:${policyName}`;

    const result = rateLimiterService.checkLimit(key, policy);

    res.setHeader('X-RateLimit-Limit', result.limit.toString());
    res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
    res.setHeader('X-RateLimit-Reset', result.resetAfterSeconds.toString());

    if (!result.allowed) {
      res.setHeader('Retry-After', result.resetAfterSeconds.toString());

      identityAuditService.emit(
        'RATE_LIMIT_EXCEEDED',
        req.user?.id || 'anonymous',
        {
          policyName,
          clientIp,
          path: req.originalUrl,
          resetAfterSeconds: result.resetAfterSeconds,
        }
      );

      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Too many requests. Please try again after ${result.resetAfterSeconds} seconds.`,
          retryAfter: result.resetAfterSeconds,
        },
      });
      return;
    }

    next();
  };
}

