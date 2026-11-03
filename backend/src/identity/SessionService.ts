import { createHash, randomBytes, randomUUID } from 'crypto';
import { prisma } from '../config/prisma';
import { UserIdentity, UserSession } from './types';
import { userService, UserService } from './UserService';
import {
  identityRehydrationService,
  IdentityRehydrationService,
} from './IdentityRehydrationService';

const DEFAULT_TTL_SECONDS = 24 * 3600; // 24 hours — unchanged session lifetime

/**
 * One-way token lookup key. Raw bearer tokens are returned once at creation
 * and never persisted; only this hash leaves the process boundary.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export class SessionService {
  constructor(
    private readonly userSvc: UserService = userService,
    private readonly rehydrationSvc: IdentityRehydrationService = identityRehydrationService
  ) {}

  /**
   * Creates a cryptographically secure, time-bounded user session.
   * The row in PostgreSQL is the source of truth; nothing authoritative
   * lives in process memory, so the session survives backend restarts.
   */
  public async createSession(
    userId: string,
    options: { ttlSeconds?: number; userAgent?: string; ipAddress?: string } = {}
  ): Promise<UserSession> {
    const user = await this.userSvc.getUserById(userId);
    if (!user) {
      throw new Error(`Cannot create session: User '${userId}' does not exist`);
    }

    if (!user.isActive) {
      throw new Error(`Cannot create session: User '${userId}' is deactivated`);
    }

    const ttlMs = (options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    // Bounded retry on id/token collision (random 256-bit token + random id;
    // a collision is near-impossible, but the unique constraints are the
    // backstop and concurrent creation must never fail spuriously).
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = `rly_${randomBytes(32).toString('hex')}`;
      const sessionId = `sess_${randomUUID().slice(0, 10)}`;
      try {
        await prisma.userSession.create({
          data: {
            id: sessionId,
            tokenHash: hashSessionToken(token),
            userId,
            residentId: user.residentId,
            authProvider: user.authProvider,
            providerAccountId: user.providerAccountId,
            email: user.email,
            phone: user.phone ?? null,
            name: user.name,
            profileImage: user.profileImage ?? null,
            userAgent: options.userAgent,
            ipAddress: options.ipAddress,
            createdAt: now,
            expiresAt,
          },
        });
        return {
          sessionId,
          userId,
          token,
          createdAt: now,
          expiresAt,
          isValid: true,
          userAgent: options.userAgent,
          ipAddress: options.ipAddress,
        };
      } catch (err: unknown) {
        if (
          attempt === 0 &&
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: unknown }).code === 'P2002'
        ) {
          continue;
        }
        throw err;
      }
    }
    throw new Error('Cannot create session: failed to allocate a unique session identifier');
  }

  /**
   * Validates a session token against persistent state, checking revocation,
   * expiration, and user active status.
   */
  public async validateSession(
    token: string
  ): Promise<{ valid: boolean; user?: UserIdentity; session?: UserSession; reason?: string }> {
    if (!token || token.trim() === '') {
      return { valid: false, reason: 'MISSING_SESSION_TOKEN' };
    }

    const row = await prisma.userSession.findUnique({
      where: { tokenHash: hashSessionToken(token) },
    });
    if (!row) {
      return { valid: false, reason: 'INVALID_SESSION_TOKEN' };
    }

    if (row.revokedAt) {
      return { valid: false, reason: 'SESSION_REVOKED' };
    }

    if (row.expiresAt.getTime() < Date.now()) {
      return { valid: false, reason: 'SESSION_EXPIRED' };
    }

    // Fast path: the user registry survived (same process lifetime), so live
    // mutations such as deactivation keep their existing immediate effect.
    let user = await this.userSvc.getUserById(row.userId);
    let userId = row.userId;
    if (!user) {
      // Post-restart (or multi-instance) restore. A live user for the same
      // provider identity always wins (the user may have logged in again
      // since the restart); otherwise onboarded users get full returning-user
      // rehydration from their durable resident row, while pre-onboarding
      // sessions restore their exact original ids. The session row is
      // repointed whenever the restored id differs. Idempotent under
      // concurrent validation — every racer resolves to the same user.
      const live = await this.userSvc.findByProvider(
        row.authProvider as UserIdentity['authProvider'],
        row.providerAccountId
      );
      if (live) {
        user = live;
      } else if (
        await this.rehydrationSvc.hasDurableResident(row.email, row.phone ?? undefined)
      ) {
        const rebuilt = await this.rehydrationSvc.resolveUser({
          id: row.userId,
          authProvider: row.authProvider as UserIdentity['authProvider'],
          providerAccountId: row.providerAccountId,
          email: row.email,
          phone: row.phone ?? undefined,
          name: row.name,
          profileImage: row.profileImage ?? undefined,
          onboardingStatus: 'AUTHENTICATED',
          residentId: row.residentId,
          isActive: true,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
        user = rebuilt.user;
      } else {
        user = await this.userSvc.restoreSessionUser({
          id: row.userId,
          authProvider: row.authProvider as UserIdentity['authProvider'],
          providerAccountId: row.providerAccountId,
          email: row.email,
          phone: row.phone ?? undefined,
          name: row.name,
          profileImage: row.profileImage ?? undefined,
          onboardingStatus: 'AUTHENTICATED',
          residentId: row.residentId,
          isActive: true,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      }
      if (user.id !== row.userId) {
        await prisma.userSession.updateMany({
          where: { id: row.id, userId: row.userId },
          data: { userId: user.id },
        });
        userId = user.id;
      }
    }

    if (!user.isActive) {
      return { valid: false, reason: 'USER_INACTIVE_OR_DELETED' };
    }

    return {
      valid: true,
      user,
      session: {
        sessionId: row.id,
        userId,
        // The presented token, echoed for the existing UserSession shape
        // (callers such as logout already hold it; nothing new is disclosed).
        token,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        isValid: true,
        userAgent: row.userAgent ?? undefined,
        ipAddress: row.ipAddress ?? undefined,
      },
    };
  }

  /**
   * Revokes an individual session upon logout. Idempotent and race-safe:
   * exactly one concurrent revoker observes `true`.
   */
  public async revokeSession(token: string): Promise<boolean> {
    if (!token || token.trim() === '') return false;
    const result = await prisma.userSession.updateMany({
      where: { tokenHash: hashSessionToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count > 0;
  }

  /**
   * Revokes all active sessions for a user (e.g. security reset or password change).
   */
  public async revokeAllUserSessions(userId: string): Promise<void> {
    await prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  public async clear(): Promise<void> {
    await prisma.userSession.deleteMany({});
  }
}

export const sessionService = new SessionService();
