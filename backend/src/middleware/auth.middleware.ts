import { Request, Response, NextFunction } from 'express';
import { sessionService } from '../identity/SessionService';
import { UserIdentity, UserSession } from '../identity/types';

// Extend Express Request interface
declare global {
  namespace Express {
    interface Request {
      user?: UserIdentity;
      residentId?: string;
      session?: UserSession;
    }
  }
}

/**
 * Extracts session token from Authorization header or cookie.
 */
export function extractToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  // Cookie fallback
  if (req.headers.cookie) {
    const match = req.headers.cookie.match(/relay_session=([^;]+)/);
    if (match) {
      return match[1].trim();
    }
  }
  return undefined;
}

/**
 * Strict authentication middleware. Rejects unauthenticated requests with HTTP 401.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required. Missing Bearer token.',
      },
    });
    return;
  }

  const result = await sessionService.validateSession(token);

  if (!result.valid || !result.user || !result.session) {
    res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: `Invalid session: ${result.reason || 'Authentication failed'}`,
      },
    });
    return;
  }

  req.user = result.user;
  req.residentId = result.user.residentId;
  req.session = result.session;

  next();
}

/**
 * Optional authentication middleware. Attaches user if valid session exists, but allows guest access.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (token) {
    const result = await sessionService.validateSession(token);
    if (result.valid && result.user && result.session) {
      req.user = result.user;
      req.residentId = result.user.residentId;
      req.session = result.session;
    }
  }
  next();
}

