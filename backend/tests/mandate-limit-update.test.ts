import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { app } from '../src/app';
import { eventBus } from '../src/events';
import { prisma } from '../src/config/prisma';
import { userService, sessionService } from '../src/identity';
import {
  mandateService,
  MandateValidationError,
  validateMandateForPayment,
} from '../src/payment';

describe('Resident payment-mandate limit management', () => {
  const createdUserIds: string[] = [];
  const createdSocietyIds: string[] = [];
  const createdResidentIds: string[] = [];
  const createdMandateRowIds: string[] = [];

  beforeEach(() => {
    eventBus.clear();
    mandateService.reset();
    userService.clear();
  });

  afterEach(async () => {
    for (const userId of createdUserIds.splice(0)) {
      await sessionService.revokeAllUserSessions(userId).catch(() => {});
    }
    if (createdMandateRowIds.length > 0) {
      await prisma.paymentMandate
        .deleteMany({ where: { id: { in: createdMandateRowIds.splice(0) } } })
        .catch(() => {});
    }
    if (createdResidentIds.length > 0) {
      await prisma.resident
        .deleteMany({ where: { id: { in: createdResidentIds.splice(0) } } })
        .catch(() => {});
    }
    if (createdSocietyIds.length > 0) {
      await prisma.society
        .deleteMany({ where: { id: { in: createdSocietyIds.splice(0) } } })
        .catch(() => {});
    }
    mandateService.reset();
    userService.clear();
    eventBus.clear();
  });

  async function createAuthedResident(tag: string) {
    const user = await userService.createUser({
      authProvider: 'EMAIL',
      providerAccountId: `ep_mandate_lim_${tag}_${randomUUID().slice(0, 8)}`,
      email: `mandate_lim_${tag}_${randomUUID().slice(0, 8)}@relay.local`,
      name: `Mandate User ${tag}`,
    });
    createdUserIds.push(user.id);
    const session = await sessionService.createSession(user.id);
    return { user, token: session.token, residentId: user.residentId };
  }

  function seedMandate(ownerReference: string, spendingLimit: number, tag: string) {
    return mandateService.createMandate({
      id: `mandate_lim_${tag}_${randomUUID().slice(0, 8)}`,
      ownerReference,
      purpose: 'COMMUNITY_PROCUREMENT',
      currency: 'INR',
      spendingLimit,
    });
  }

  async function mirrorMandateRow(mandateId: string, residentId: string, maximumAmount: number) {
    const society = await prisma.society.create({
      data: {
        name: 'Limit Test Society',
        address: '1 Test Road',
        city: 'Nashik',
        state: 'MH',
        postalCode: '422001',
      },
    });
    createdSocietyIds.push(society.id);
    const resident = await prisma.resident.create({
      data: {
        id: residentId,
        societyId: society.id,
        name: 'Limit Test Resident',
        email: `mirror_${randomUUID().slice(0, 12)}@relay.local`,
        flatNumber: 'T-1',
      },
    });
    createdResidentIds.push(resident.id);
    const row = await prisma.paymentMandate.create({
      data: {
        id: mandateId,
        residentId: resident.id,
        status: 'ACTIVE',
        maximumAmount,
        currency: 'INR',
        purpose: 'COMMUNITY_PROCUREMENT',
        periodStart: new Date(),
      },
    });
    createdMandateRowIds.push(row.id);
    return row;
  }

  it('1. Authenticated resident can change their own limit', async () => {
    const { token, residentId } = await createAuthedResident('owner');
    const mandate = seedMandate(residentId, 10000, 'owner');

    const res = await request(app)
      .patch('/api/portal/mandate')
      .set('Authorization', `Bearer ${token}`)
      .send({ spendingLimit: 15000 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(mandate.id);
    expect(res.body.data.maximumAmount).toBe(15000);
    expect(res.body.data.status).toBe('ACTIVE');
    expect(mandateService.getMandate(mandate.id)!.spendingLimit).toBe(15000);
  });

  it('2. Unauthenticated request is rejected', async () => {
    const res = await request(app).patch('/api/portal/mandate').send({ spendingLimit: 15000 });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('3. Another resident cannot change the mandate', async () => {
    const owner = await createAuthedResident('owner3');
    const stranger = await createAuthedResident('stranger3');
    const mandate = seedMandate(owner.residentId, 10000, 'owner3');
    seedMandate(stranger.residentId, 5000, 'stranger3');

    // Stranger's update touches only their own mandate.
    const res = await request(app)
      .patch('/api/portal/mandate')
      .set('Authorization', `Bearer ${stranger.token}`)
      .send({ spendingLimit: 7777 });
    expect(res.status).toBe(200);
    expect(mandateService.getMandate(mandate.id)!.spendingLimit).toBe(10000);

    // Forged resident id in body is rejected as IDOR attempt.
    const forged = await request(app)
      .patch('/api/portal/mandate')
      .set('Authorization', `Bearer ${stranger.token}`)
      .send({ spendingLimit: 1, residentId: owner.residentId });
    expect(forged.status).toBe(403);
    expect(mandateService.getMandate(mandate.id)!.spendingLimit).toBe(10000);
  });

  it('4. Invalid amounts are rejected', async () => {
    const { token, residentId } = await createAuthedResident('invalid');
    const mandate = seedMandate(residentId, 10000, 'invalid');

    for (const body of [
      { spendingLimit: -500 },
      { spendingLimit: 0 },
      { spendingLimit: '10000' },
      { spendingLimit: null },
      {},
      { spendingLimit: 1000001 },
      { spendingLimit: 0.001 },
    ]) {
      const res = await request(app)
        .patch('/api/portal/mandate')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    }
    expect(mandateService.getMandate(mandate.id)!.spendingLimit).toBe(10000);

    // Service-level backstop rejects non-finite values even if called directly.
    await expect(mandateService.updateSpendingLimit(mandate.id, NaN)).rejects.toThrow(
      MandateValidationError
    );
    await expect(mandateService.updateSpendingLimit(mandate.id, Infinity)).rejects.toThrow(
      MandateValidationError
    );
    await expect(mandateService.updateSpendingLimit(mandate.id, -1)).rejects.toThrow(
      MandateValidationError
    );
  });

  it('5. Decimal values are preserved exactly', async () => {
    const { token, residentId } = await createAuthedResident('decimal');
    const mandate = seedMandate(residentId, 10000, 'decimal');

    const res = await request(app)
      .patch('/api/portal/mandate')
      .set('Authorization', `Bearer ${token}`)
      .send({ spendingLimit: 10499.99 });

    expect(res.status).toBe(200);
    expect(res.body.data.maximumAmount).toBe(10499.99);
    expect(mandateService.getMandate(mandate.id)!.spendingLimit).toBe(10499.99);
  });

  it('6. Reducing below already-used amount keeps history valid with zero remaining', async () => {
    const { token, residentId } = await createAuthedResident('reduce');
    const mandate = seedMandate(residentId, 10000, 'reduce');
    mandateService.commitSpending(mandate.id, 2450);

    const res = await request(app)
      .patch('/api/portal/mandate')
      .set('Authorization', `Bearer ${token}`)
      .send({ spendingLimit: 2000 });

    expect(res.status).toBe(200);
    const stored = mandateService.getMandate(mandate.id)!;
    expect(stored.spendingLimit).toBe(2000);
    expect(stored.spentAmount).toBe(2450);
    expect(res.body.data.remainingLimit).toBe(0);
    expect(mandateService.getRemainingCapacity(mandate.id)).toBe(0);

    // Existing deterministic rule blocks further spend; history untouched.
    const blocked = await mandateService.reserveCapacity(mandate.id, 100, {
      currency: 'INR',
      purpose: 'COMMUNITY_PROCUREMENT',
    });
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('SPENDING_LIMIT_EXCEEDED');
    expect(mandateService.getMandate(mandate.id)!.spentAmount).toBe(2450);
  });

  it('7. Increasing the limit restores capacity', async () => {
    const { token, residentId } = await createAuthedResident('increase');
    const mandate = seedMandate(residentId, 5000, 'increase');
    mandateService.commitSpending(mandate.id, 4500);
    expect(mandateService.getRemainingCapacity(mandate.id)).toBe(500);

    const res = await request(app)
      .patch('/api/portal/mandate')
      .set('Authorization', `Bearer ${token}`)
      .send({ spendingLimit: 15000 });

    expect(res.status).toBe(200);
    expect(res.body.data.remainingLimit).toBe(10500);
    expect(mandateService.getRemainingCapacity(mandate.id)).toBe(10500);
  });

  it('8. Payment authorization uses the updated limit', async () => {
    const { token, residentId } = await createAuthedResident('authz');
    const mandate = seedMandate(residentId, 10000, 'authz');

    await request(app)
      .patch('/api/portal/mandate')
      .set('Authorization', `Bearer ${token}`)
      .send({ spendingLimit: 3000 });

    const live = mandateService.getMandate(mandate.id)!;
    const denied = validateMandateForPayment(
      live,
      { amount: 5000, currency: 'INR', purpose: 'COMMUNITY_PROCUREMENT' },
      {}
    );
    expect(denied.valid).toBe(false);
    expect(denied.errors.join(' ')).toContain('SPENDING_LIMIT_EXCEEDED');

    const allowed = await mandateService.reserveCapacity(mandate.id, 2500, {
      currency: 'INR',
      purpose: 'COMMUNITY_PROCUREMENT',
    });
    expect(allowed.success).toBe(true);
    expect(allowed.remainingCapacity).toBe(500);
  });

  it('9. Concurrent limit update and payment reservation stay deterministic', async () => {
    const svc = mandateService;
    const mandate = seedMandate('res_concurrent', 10000, 'conc');

    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i++) {
      ops.push(
        svc.reserveCapacity(mandate.id, 500, { currency: 'INR', purpose: 'COMMUNITY_PROCUREMENT' })
      );
      ops.push(svc.updateSpendingLimit(mandate.id, 10000 + i * 100));
    }
    const results = await Promise.all(ops.map((p) => p.then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e })
    )));

    // Every operation settled; none threw unexpectedly or produced NaN state.
    expect(results).toHaveLength(20);
    const stored = svc.getMandate(mandate.id)!;
    expect(Number.isFinite(stored.spendingLimit)).toBe(true);
    expect(Number.isFinite(stored.reservedAmount)).toBe(true);
    expect(Number.isFinite(stored.spentAmount)).toBe(true);
    expect(stored.reservedAmount).toBeGreaterThanOrEqual(0);
    const remaining = svc.getRemainingCapacity(mandate.id);
    expect(remaining).toBe(Math.max(0, stored.spendingLimit - stored.spentAmount - stored.reservedAmount));

    // All-or-nothing per reservation: total reserved never exceeds 10 x 500
    // and every successful reservation observed a consistent limit.
    expect(stored.reservedAmount).toBeLessThanOrEqual(5000);
    const successes = results.filter(
      (r) => r.ok && (r.v as { success: boolean }).success === true
    );
    expect(successes.length * 500).toBe(stored.reservedAmount);
  });

  it('10. Limit change emits an audit event with previous and new values', async () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const handler = (evt: { name: string; payload: Record<string, unknown> }) => events.push(evt);
    eventBus.subscribe('PAYMENT_MANDATE_LIMIT_UPDATED', handler);

    const { user, token, residentId } = await createAuthedResident('audit');
    const mandate = seedMandate(residentId, 10000, 'audit');

    await request(app)
      .patch('/api/portal/mandate')
      .set('Authorization', `Bearer ${token}`)
      .send({ spendingLimit: 12000 });

    await new Promise((r) => setTimeout(r, 25));
    eventBus.unsubscribe('PAYMENT_MANDATE_LIMIT_UPDATED', handler);

    expect(events.length).toBe(1);
    expect(events[0].name).toBe('PAYMENT_MANDATE_LIMIT_UPDATED');
    expect(events[0].payload.mandateId).toBe(mandate.id);
    expect(events[0].payload.previousLimit).toBe(10000);
    expect(events[0].payload.newLimit).toBe(12000);
    expect(events[0].payload.userId).toBe(user.id);
    const serialized = JSON.stringify(events[0].payload).toLowerCase();
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('cvv');
    expect(serialized).not.toContain('token');
  });

  it('11. Refresh and re-login show the persisted updated limit', async () => {
    const { user, token, residentId } = await createAuthedResident('persist');
    const mandate = seedMandate(residentId, 10000, 'persist');
    await mirrorMandateRow(mandate.id, residentId, 10000);

    const patch = await request(app)
      .patch('/api/portal/mandate')
      .set('Authorization', `Bearer ${token}`)
      .send({ spendingLimit: 18000 });
    expect(patch.status).toBe(200);

    // Durable mirror row carries the new limit.
    const row = await prisma.paymentMandate.findUnique({ where: { id: mandate.id } });
    expect(Number(row!.maximumAmount)).toBe(18000);

    // Re-login: brand-new session observes the updated limit via portal reads.
    const fresh = await sessionService.createSession(user.id);
    const profile = await request(app)
      .get('/api/portal/resident')
      .set('Authorization', `Bearer ${fresh.token}`);
    expect(profile.status).toBe(200);
    expect(profile.body.data.activeMandate.maximumAmount).toBe(18000);
  });

  it('12. Revoked mandates cannot change limits', async () => {
    const { token, residentId } = await createAuthedResident('revoked');
    const mandate = seedMandate(residentId, 10000, 'revoked');
    mandateService.revokeMandate(mandate.id);

    // No ACTIVE mandate remains, so the endpoint honestly reports absence.
    const res = await request(app)
      .patch('/api/portal/mandate')
      .set('Authorization', `Bearer ${token}`)
      .send({ spendingLimit: 15000 });
    expect(res.status).toBe(404);

    // Direct service call fails closed as well.
    await expect(mandateService.updateSpendingLimit(mandate.id, 15000)).rejects.toThrow(
      MandateValidationError
    );
  });
});
