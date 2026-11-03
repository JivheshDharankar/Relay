import { Request, Response, NextFunction } from 'express';
import { identityAuditService } from '../identity/IdentityAuditService';
import { membershipService } from '../identity/MembershipService';
import { prisma } from '../config/prisma';

/**
 * Ensures that the authenticated user can ONLY access resources belonging to their own residentId.
 * Blocks all Insecure Direct Object Reference (IDOR) attacks.
 */
export function requireResidentOwnership(paramName: string = 'residentId') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !req.residentId) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const requestedResidentId =
      req.params[paramName] || req.query[paramName] || req.body[paramName];

    // If client specified a target residentId, verify exact match with authenticated identity
    if (requestedResidentId && requestedResidentId !== req.residentId) {
      identityAuditService.emit('UNAUTHORIZED_ACCESS_ATTEMPT', req.user.id, {
        attemptedResidentId: requestedResidentId,
        actualResidentId: req.residentId,
        path: req.originalUrl,
        method: req.method,
      });

      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied: You cannot access or modify another resident’s data',
        },
      });
      return;
    }

    next();
  };
}

/**
 * Resolves the session resident's society: onboarding membership first (the
 * source of truth for users), else the society of their canonical resident row.
 */
export async function getSessionSocietyId(req: Request): Promise<string | undefined> {
  if (!req.user) return undefined;
  const membership = await membershipService.getMembershipByUserId(req.user.id);
  if (membership?.societyId) return membership.societyId;
  if (req.residentId) {
    const resident = await prisma.resident.findUnique({
      where: { id: req.residentId },
      select: { societyId: true },
    });
    return resident?.societyId;
  }
  return undefined;
}

function forbiddenScope(
  req: Request,
  res: Response,
  attempted: unknown,
  actual: unknown
): void {
  identityAuditService.emit('UNAUTHORIZED_ACCESS_ATTEMPT', req.user!.id, {
    attempted,
    actual,
    path: req.originalUrl,
    method: req.method,
  });
  res.status(403).json({
    success: false,
    error: {
      code: 'FORBIDDEN',
      message: 'Access denied: target is outside your resident or society scope',
    },
  });
}

/**
 * Binds procurement/execution targets to the session:
 * - residentId must equal the session resident;
 * - societyId must equal the session society;
 * - residentOrderId must exist and belong to the session resident;
 * - communityOrderId must exist and belong to the session society.
 * Missing orders yield 404 (same as the services); out-of-scope yields 403.
 */
export function requireProcurementScope() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user || !req.residentId) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const src = {
      ...(req.query as Record<string, unknown>),
      ...(req.params as Record<string, unknown>),
      ...((req.body as Record<string, unknown> | undefined) ?? {}),
    };

    if (src.residentId && src.residentId !== req.residentId) {
      forbiddenScope(req, res, src.residentId, req.residentId);
      return;
    }

    if (src.societyId) {
      const societyId = await getSessionSocietyId(req);
      if (!societyId || src.societyId !== societyId) {
        forbiddenScope(req, res, src.societyId, societyId ?? null);
        return;
      }
    }

    if (src.residentOrderId) {
      const order =
        typeof src.residentOrderId === 'string'
          ? await prisma.residentOrder.findUnique({
              where: { id: src.residentOrderId },
              select: { residentId: true },
            })
          : null;
      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'RESIDENT_ORDER_NOT_FOUND', message: 'Resident order not found' },
        });
        return;
      }
      if (order.residentId !== req.residentId) {
        forbiddenScope(req, res, src.residentOrderId, req.residentId);
        return;
      }
    }

    if (src.communityOrderId) {
      const order =
        typeof src.communityOrderId === 'string'
          ? await prisma.communityOrder.findUnique({
              where: { id: src.communityOrderId },
              select: { societyId: true },
            })
          : null;
      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'COMMUNITY_ORDER_NOT_FOUND', message: 'Community order not found' },
        });
        return;
      }
      const societyId = await getSessionSocietyId(req);
      if (!societyId || order.societyId !== societyId) {
        forbiddenScope(req, res, src.communityOrderId, societyId ?? null);
        return;
      }
    }

    next();
  };
}

