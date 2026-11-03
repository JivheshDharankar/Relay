import { describe, it, expect, afterEach } from 'vitest';
import { createHash, randomUUID } from 'crypto';
import { prisma } from '../src/config/prisma';
import { userService } from '../src/identity/UserService';
import { sessionService } from '../src/identity/SessionService';

const createdUserIds: string[] = [];

async function createSessionUser(email: string) {
  const user = await userService.createUser({
    authProvider: 'EMAIL',
    providerAccountId: `sess_test_${randomUUID().slice(0, 8)}`,
    email,
    name: 'Session Persistence Resident',
  });
  createdUserIds.push(user.id);
  return user;
}

afterEach(async () => {
  userService.clear();
  if (createdUserIds.length > 0) {
    await prisma.userSession.deleteMany({ where: { userId: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

describe('Session persistence across backend restarts', () => {
  it('a valid session still validates after the in-memory registries are wiped', async () => {
    const user = await createSessionUser(`persist_${randomUUID().slice(0, 8)}@relay.local`);
    const session = await sessionService.createSession(user.id);

    expect((await sessionService.validateSession(session.token)).valid).toBe(true);

    // Simulate a backend restart: process-local registries are empty, but the
    // database row (the source of truth) survives.
    userService.clear();

    const after = await sessionService.validateSession(session.token);
    expect(after.valid).toBe(true);
    expect(after.user?.id).toBe(user.id);
    expect(after.user?.email).toBe(user.email);
    expect(after.user?.residentId).toBe(user.residentId);
    expect(after.session?.sessionId).toBe(session.sessionId);
  });

  it('an onboarded user keeps the canonical durable residentId after a restart', async () => {
    const email = `onboarded_${randomUUID().slice(0, 8)}@relay.local`;
    const society = await prisma.society.create({
      data: {
        name: 'Persistence Society',
        address: '1 Durable Road',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
      },
    });
    const resident = await prisma.resident.create({
      data: {
        societyId: society.id,
        name: 'Onboarded Resident',
        email,
        flatNumber: 'A-1',
      },
    });
    try {
      const user = await createSessionUser(email);
      const session = await sessionService.createSession(user.id);

      userService.clear();

      const after = await sessionService.validateSession(session.token);
      expect(after.valid).toBe(true);
      // Rehydration pins the durable resident row — never a fresh id.
      expect(after.user?.residentId).toBe(resident.id);
    } finally {
      await prisma.resident.deleteMany({ where: { id: resident.id } });
      await prisma.society.deleteMany({ where: { id: society.id } });
    }
  });

  it('never stores the raw bearer token, only its hash', async () => {
    const user = await createSessionUser(`hash_${randomUUID().slice(0, 8)}@relay.local`);
    const session = await sessionService.createSession(user.id);

    const row = await prisma.userSession.findUnique({
      where: { tokenHash: createHash('sha256').update(session.token, 'utf8').digest('hex') },
    });
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(session.token);
  });

  it('preserves the 24-hour session TTL', async () => {
    const user = await createSessionUser(`ttl_${randomUUID().slice(0, 8)}@relay.local`);
    const session = await sessionService.createSession(user.id);
    const ttlMs = session.expiresAt.getTime() - session.createdAt.getTime();
    expect(ttlMs).toBe(24 * 3600 * 1000);
  });

  it('still rejects expired, revoked, and tampered sessions', async () => {
    const user = await createSessionUser(`reject_${randomUUID().slice(0, 8)}@relay.local`);

    const expired = await sessionService.createSession(user.id, { ttlSeconds: -10 });
    const expiredCheck = await sessionService.validateSession(expired.token);
    expect(expiredCheck.valid).toBe(false);
    expect(expiredCheck.reason).toBe('SESSION_EXPIRED');

    const session = await sessionService.createSession(user.id);
    expect(await sessionService.revokeSession(session.token)).toBe(true);
    expect(await sessionService.revokeSession(session.token)).toBe(false);
    const revokedCheck = await sessionService.validateSession(session.token);
    expect(revokedCheck.valid).toBe(false);
    expect(revokedCheck.reason).toBe('SESSION_REVOKED');

    const tampered = await sessionService.validateSession(`${session.token}tampered`);
    expect(tampered.valid).toBe(false);
    expect(tampered.reason).toBe('INVALID_SESSION_TOKEN');
  });

  it('revoking all user sessions invalidates every concurrent session', async () => {
    const user = await createSessionUser(`revokeall_${randomUUID().slice(0, 8)}@relay.local`);
    const s1 = await sessionService.createSession(user.id);
    const s2 = await sessionService.createSession(user.id);

    await sessionService.revokeAllUserSessions(user.id);

    expect((await sessionService.validateSession(s1.token)).valid).toBe(false);
    expect((await sessionService.validateSession(s2.token)).valid).toBe(false);
  });
});
