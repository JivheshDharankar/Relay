import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../src/app';
import { seed, SEED_IDS } from '../prisma/seed';
import {
  userService,
  profileService,
  addressService,
  societyService,
  membershipService,
  sessionService,
  rateLimiterService,
  distributedLockService,
  emailPhoneAuthProvider,
} from '../src/identity';
import { mandateService } from '../src/payment/mandate/MandateService';
import { relayOrchestrator } from '../src/orchestration';
import { eventBus } from '../src/events';

const prisma = new PrismaClient();

// Test DATA coordinates near Baner, Pune — inside the seeded suppliers'
// service radii (Sahyadri 15km, Deccan 20km). This reflects backend geography
// capability; the fix itself references no city.
const NEAR_BANER = { latitude: 18.5601, longitude: 73.7801 };

async function clearIdentity() {
  userService.clear();
  profileService.clear();
  addressService.clear();
  societyService.clear();
  membershipService.clear();
  await sessionService.clear();
  rateLimiterService.clear();
  distributedLockService.clear();
  emailPhoneAuthProvider.clear();
  mandateService.reset();
  eventBus.clear();
}

async function cleanupSocieties(ids: string[]) {
  for (const id of ids) {
    await prisma.communityOrder.deleteMany({ where: { societyId: id } });
    await prisma.residentOrder.deleteMany({ where: { societyId: id } });
    await prisma.society.deleteMany({ where: { id } });
  }
}

interface FreshUser {
  email: string;
  token: string;
  userId: string;
  residentId: string;
  societyId: string;
}

/**
 * Drives the legitimate public path: OTP auth -> profile -> address ->
 * society register+join -> verify -> mandate. No seeds, no bypasses.
 */
async function onboardFreshUser(opts: {
  emailPrefix: string;
  societyName: string;
  mandateLimit: number;
  tower?: string;
  flat?: string;
}): Promise<FreshUser> {
  const suffix = randomUUID().slice(0, 8);
  const email = `${opts.emailPrefix}.${suffix}@example.com`;

  const otpRes = await request(app).post('/api/auth/email/request-otp').send({ email });
  expect(otpRes.status).toBe(200);

  const verifyRes = await request(app)
    .post('/api/auth/email/verify-otp')
    .send({ email, otpCode: '123456' });
  expect(verifyRes.status).toBe(200);
  const token: string = verifyRes.body.data.session.token;
  const userId: string = verifyRes.body.data.user.id;
  const residentId: string = verifyRes.body.data.user.residentId;
  const auth = { Authorization: `Bearer ${token}` };

  const profileRes = await request(app)
    .post('/api/onboarding/profile')
    .set(auth)
    .send({ fullName: `Fresh User ${suffix}`, email });
  expect(profileRes.status).toBe(200);

  const addressRes = await request(app).post('/api/onboarding/address').set(auth).send({
    addressLine: `Flat ${opts.flat ?? '7B'}, Test Road`,
    city: 'Pune',
    state: 'Maharashtra',
    postalCode: '411045',
    latitude: NEAR_BANER.latitude,
    longitude: NEAR_BANER.longitude,
  });
  expect(addressRes.status).toBe(200);

  const regRes = await request(app).post('/api/societies/register').set(auth).send({
    name: `${opts.societyName} ${suffix}`,
    address: 'Test Road, Baner',
    city: 'Pune',
    state: 'Maharashtra',
    postalCode: '411045',
    latitude: NEAR_BANER.latitude,
    longitude: NEAR_BANER.longitude,
  });
  expect(regRes.status).toBe(201);
  const societyId: string = regRes.body.data.id;
  expect(societyId.startsWith('soc_')).toBe(true);

  const joinRes = await request(app).post('/api/onboarding/society').set(auth).send({
    societyId,
    tower: opts.tower ?? 'C',
    flatNumber: opts.flat ?? '7B',
  });
  expect(joinRes.status).toBe(200);

  const verifySocRes = await request(app).post('/api/onboarding/verify-society').set(auth).send({ attestResidence: true });
  expect(verifySocRes.status).toBe(200);

  const mandateRes = await request(app).post('/api/onboarding/payment-mandate').set(auth).send({
    spendingLimit: opts.mandateLimit,
    currency: 'INR',
  });
  expect(mandateRes.status).toBe(200);
  expect(mandateRes.body.data.isComplete).toBe(true);

  return { email, token, userId, residentId, societyId };
}

describe('P0 — Fresh-user identity persistence & legitimate procurement lifecycle', () => {
  const createdSocieties: string[] = [];

  beforeAll(async () => {
    await seed(prisma);
  });

  beforeEach(async () => {
    await clearIdentity();
  });

  afterEach(async () => {
    await cleanupSocieties(createdSocieties.splice(0));
    await clearIdentity();
  });

  it('1. persists a freshly onboarded society to Prisma under its soc_* identity', async () => {
    const u = await onboardFreshUser({
      emailPrefix: 'persist.soc',
      societyName: 'Persist Heights',
      mandateLimit: 10000,
    });
    createdSocieties.push(u.societyId);

    const run = await request(app)
      .post('/api/agent/run')
      .set({ Authorization: `Bearer ${u.token}` })
      .send({ message: 'I need 2 kg of raw groundnuts within 12 hours' });
    expect(run.status).toBe(200);

    const row = await prisma.society.findUnique({ where: { id: u.societyId } });
    expect(row).toBeDefined();
    expect(row!.city).toBe('Pune');
    expect(Number(row!.latitude)).toBeCloseTo(NEAR_BANER.latitude, 4);
    expect(Number(row!.longitude)).toBeCloseTo(NEAR_BANER.longitude, 4);
  });

  it('2. persists a freshly authenticated resident to Prisma under its res_* identity', async () => {
    const u = await onboardFreshUser({
      emailPrefix: 'persist.res',
      societyName: 'Resident Gardens',
      mandateLimit: 10000,
      tower: 'D',
      flat: '12A',
    });
    createdSocieties.push(u.societyId);

    const run = await request(app)
      .post('/api/agent/run')
      .set({ Authorization: `Bearer ${u.token}` })
      .send({ message: 'I need 2 kg of raw groundnuts within 12 hours' });
    expect(run.status).toBe(200);

    const row = await prisma.resident.findUnique({ where: { id: u.residentId } });
    expect(row).toBeDefined();
    expect(row!.societyId).toBe(u.societyId);
    expect(row!.email).toBe(u.email);
    expect(row!.flatNumber).toBe('D-12A');
    expect(row!.status).toBe('ACTIVE');
  });

  it('3. session resident ID matches the canonical resident identity used by procurement', async () => {
    const u = await onboardFreshUser({
      emailPrefix: 'sess.id',
      societyName: 'Session Towers',
      mandateLimit: 10000,
    });
    createdSocieties.push(u.societyId);

    const run = await request(app)
      .post('/api/agent/run')
      .set({ Authorization: `Bearer ${u.token}` })
      .send({ message: 'I need 2 kg of raw groundnuts within 12 hours' });
    expect(run.status).toBe(200);
    const createStep = (run.body.steps as any[]).find((s) => s.toolCall?.name === 'createRequest');
    expect(createStep?.toolCall?.error).toBeUndefined();
    const orderId: string = createStep.toolCall.result.orderId;

    const order = await prisma.residentOrder.findUnique({ where: { id: orderId } });
    expect(order).toBeDefined();
    expect(order!.residentId).toBe(u.residentId);
  });

  it('4. residents procure only for their verified society (spoofed society rejected)', async () => {
    const u = await onboardFreshUser({
      emailPrefix: 'soc.iso',
      societyName: 'Isolation Enclave',
      mandateLimit: 10000,
    });
    createdSocieties.push(u.societyId);

    const run = await request(app)
      .post('/api/agent/run')
      .set({ Authorization: `Bearer ${u.token}` })
      .send({ message: 'I need 2 kg of raw groundnuts within 12 hours' });
    expect(run.status).toBe(200);
    const aggStep = (run.body.steps as any[]).find((s) => s.toolCall?.name === 'aggregateDemand');
    expect(aggStep?.toolCall?.result?.societyId).toBe(u.societyId);

    const spoof = await request(app)
      .post('/api/agent/run')
      .set({ Authorization: `Bearer ${u.token}` })
      .send({ message: '2 kg sugar', societyId: SEED_IDS.society.greenview });
    expect(spoof.status).toBe(403);
    expect(spoof.body.error.code).toBe('FORBIDDEN');
  });

  it('5. IDOR: resident A cannot touch resident B procurement/order data', async () => {
    const a = await onboardFreshUser({
      emailPrefix: 'idor.a',
      societyName: 'Alpha Court',
      mandateLimit: 10000,
    });
    const b = await onboardFreshUser({
      emailPrefix: 'idor.b',
      societyName: 'Beta Court',
      mandateLimit: 10000,
    });
    createdSocieties.push(a.societyId, b.societyId);

    const spoofRun = await request(app)
      .post('/api/agent/run')
      .set({ Authorization: `Bearer ${a.token}` })
      .send({ message: '2 kg sugar', residentId: b.residentId });
    expect(spoofRun.status).toBe(403);

    const spoofSoc = await request(app)
      .post('/api/agent/run')
      .set({ Authorization: `Bearer ${a.token}` })
      .send({ message: '2 kg sugar', societyId: b.societyId });
    expect(spoofSoc.status).toBe(403);

    const bRun = await request(app)
      .post('/api/agent/run')
      .set({ Authorization: `Bearer ${b.token}` })
      .send({ message: 'I need 2 kg of raw groundnuts within 12 hours' });
    expect(bRun.status).toBe(200);

    const aOrders = await request(app)
      .get('/api/portal/orders')
      .set({ Authorization: `Bearer ${a.token}` });
    expect(aOrders.status).toBe(200);
    expect(aOrders.body.data).toEqual([]);

    const crossRead = await request(app)
      .get(`/api/portal/orders?residentId=${b.residentId}`)
      .set({ Authorization: `Bearer ${a.token}` });
    expect(crossRead.status).toBe(403);
  });

  it('6. procurement beyond the mandate is rejected and never paid', async () => {
    const u = await onboardFreshUser({
      emailPrefix: 'mand.cap',
      societyName: 'Ceiling View',
      mandateLimit: 10,
    });
    createdSocieties.push(u.societyId);

    const run = await request(app)
      .post('/api/agent/run')
      .set({ Authorization: `Bearer ${u.token}` })
      .send({ message: 'I need 2 kg of raw groundnuts within 12 hours' });
    expect(run.status).toBe(200);
    const authStep = (run.body.steps as any[]).find(
      (s) => s.toolCall?.name === 'checkAuthorization'
    );
    expect(authStep?.toolCall?.result?.authorized).toBe(false);
    expect(authStep?.toolCall?.result?.reason).toContain('MANDATE_LIMIT_EXCEEDED');

    const commStep = (run.body.steps as any[]).find(
      (s) => s.toolCall?.name === 'createCommunityOrder'
    );
    const communityOrderId: string | undefined = commStep?.toolCall?.result?.order?.id;
    if (communityOrderId) {
      const pay = await request(app)
        .post('/api/execution/full-cycle')
        .set({ Authorization: `Bearer ${u.token}` })
        .send({ communityOrderId });
      expect(pay.status).toBe(400);
    }
    const payments = await prisma.payment.findMany({
      where: { residentOrder: { residentId: u.residentId } },
    });
    expect(payments).toEqual([]);
  });

  it('7. unauthenticated run requests are rejected and create no orders', async () => {
    const before = await prisma.residentOrder.count({
      where: { residentId: SEED_IDS.residents.aarav },
    });
    const run = await request(app)
      .post('/api/agent/run')
      .send({ message: 'I need 1 kg of organic cane sugar' });
    expect(run.status).toBe(401);
    expect(run.body.success).toBe(false);
    expect(run.body.error.code).toBe('UNAUTHORIZED');

    // Explicit seed ids in the body do not resurrect the anonymous path.
    const spoofed = await request(app)
      .post('/api/agent/run')
      .send({
        residentId: SEED_IDS.residents.aarav,
        societyId: SEED_IDS.society.greenview,
        message: 'I need 1 kg of organic cane sugar',
      });
    expect(spoofed.status).toBe(401);

    const after = await prisma.residentOrder.count({
      where: { residentId: SEED_IDS.residents.aarav },
    });
    expect(after).toBe(before);
  });

  it('8. full fresh lifecycle: onboarded resident completes procure-to-reconcile', async () => {
    const u = await onboardFreshUser({
      emailPrefix: 'full.life',
      societyName: 'Lifecycle Residency',
      mandateLimit: 10000,
    });
    createdSocieties.push(u.societyId);

    const run = await request(app)
      .post('/api/agent/run')
      .set({ Authorization: `Bearer ${u.token}` })
      .send({ message: 'I need 2 kg of raw groundnuts within 12 hours please, full-cycle community procurement' });
    expect(run.status).toBe(200);
    expect(run.body.success).toBe(true);

    const steps = run.body.steps as any[];
    const tools = steps.filter((s) => s.toolCall).map((s) => s.toolCall.name);
    for (const name of [
      'createRequest',
      'checkAuthorization',
      'aggregateDemand',
      'discoverSuppliers',
      'evaluateOffers',
      'selectOffer',
      'createCommunityOrder',
      'allocateResidentOrders',
      'requestPayment',
      'trackDelivery',
      'reconcileOrder',
    ]) {
      expect(tools).toContain(name);
    }
    const errors = steps.filter((s) => s.toolCall?.error);
    expect(errors).toEqual([]);

    const byName = (n: string) => steps.find((s) => s.toolCall?.name === n).toolCall.result;
    expect(byName('createRequest').productName).toContain('Groundnut');
    expect(byName('checkAuthorization').authorized).toBe(true);
    expect(byName('discoverSuppliers').eligibleCount).toBeGreaterThanOrEqual(2);
    expect(byName('selectOffer').supplierId).toBeDefined();
    expect(byName('reconcileOrder').status).toBe('RECONCILED');
    expect(byName('reconcileOrder').isReconciled).toBe(true);
    expect(run.body.response).toContain('Relay autonomous procurement is complete');
    expect(run.body.response).not.toContain('could not complete');
    // Success messaging must not name a society the run never used.
    expect(run.body.response).not.toContain('Greenview');

    const payment = await prisma.payment.findFirst({
      where: { residentOrder: { residentId: u.residentId } },
    });
    expect(payment).toBeDefined();
    expect(payment!.status).toBe('SUCCESS');

    // Delivery address derives from canonical records, never a seed flat.
    const freshOrder = await prisma.residentOrder.findUnique({
      where: { id: byName('createRequest').orderId },
    });
    expect(freshOrder!.deliveryAddress).toContain('C-7B');
    expect(freshOrder!.deliveryAddress).toContain('Lifecycle Residency');
    expect(freshOrder!.deliveryAddress).not.toContain('Tower A-101');
  });

  it('rejects authenticated procurement before society membership with a controlled error', async () => {
    const email = `nomember.${randomUUID().slice(0, 8)}@example.com`;
    await request(app).post('/api/auth/email/request-otp').send({ email });
    const verifyRes = await request(app)
      .post('/api/auth/email/verify-otp')
      .send({ email, otpCode: '123456' });
    const token = verifyRes.body.data.session.token;

    const run = await request(app)
      .post('/api/agent/run')
      .set({ Authorization: `Bearer ${token}` })
      .send({ message: '2 kg sugar' });
    expect(run.status).toBe(422);
    expect(run.body.error.code).toBe('ONBOARDING_INCOMPLETE');
  });

  it('B. members see their own society community, never another society as theirs', async () => {
    const u = await onboardFreshUser({
      emailPrefix: 'comm.scope',
      societyName: 'Scope Gardens',
      mandateLimit: 10000,
    });
    createdSocieties.push(u.societyId);

    const own = await request(app)
      .get('/api/portal/community')
      .set({ Authorization: `Bearer ${u.token}` });
    expect(own.status).toBe(200);
    expect(own.body.data.id).toBe(u.societyId);

    const spoof = await request(app)
      .get(`/api/portal/community?societyId=${SEED_IDS.society.greenview}`)
      .set({ Authorization: `Bearer ${u.token}` });
    expect(spoof.status).toBe(200);
    expect(spoof.body.data.id).toBe(u.societyId);
    for (const pool of spoof.body.data.activeDemandPools) {
      expect((pool as any).residentNames).toBeUndefined();
      expect((pool as any).residentName).toBeUndefined();
    }
  });

  it('C. unknown supplier-delivery-view society is a controlled 404, not a 500', async () => {
    const missing = await request(app).get('/api/societies/soc_missing_123/supplier-delivery-view');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('SOCIETY_NOT_FOUND');

    const u = await onboardFreshUser({
      emailPrefix: 'deliv.view',
      societyName: 'Delivery Court',
      mandateLimit: 10000,
    });
    createdSocieties.push(u.societyId);
    const known = await request(app).get(`/api/societies/${u.societyId}/supplier-delivery-view`);
    expect(known.status).toBe(200);
    expect(known.body.data.societyId).toBe(u.societyId);
    expect(JSON.stringify(known.body.data)).not.toContain('7B');
  });

  it('C2. guest society registration is rejected with 401', async () => {
    const guest = await request(app).post('/api/societies/register').send({
      name: 'Guest Society',
      address: 'Nowhere',
      city: 'Pune',
      state: 'MH',
      postalCode: '411001',
      latitude: 18.5,
      longitude: 73.8,
    });
    expect(guest.status).toBe(401);
  });

  it('C3. mission cancellation is owner-only and refused after payment', async () => {
    const u = await onboardFreshUser({
      emailPrefix: 'cancel.owner',
      societyName: 'Cancel Court',
      mandateLimit: 10000,
    });
    createdSocieties.push(u.societyId);
    const other = await onboardFreshUser({
      emailPrefix: 'cancel.other',
      societyName: 'Cancel Other Court',
      mandateLimit: 10000,
    });
    createdSocieties.push(other.societyId);

    const wf = await relayOrchestrator.createWorkflow({
      requestText: '2 kg sugar',
      residentReference: u.residentId,
      societyReference: u.societyId,
    });

    const guest = await request(app).post(`/api/agent/workflow/${wf.id}/cancel`).send({});
    expect(guest.status).toBe(401);

    const cross = await request(app)
      .post(`/api/agent/workflow/${wf.id}/cancel`)
      .set({ Authorization: `Bearer ${other.token}` })
      .send({});
    expect(cross.status).toBe(403);

    const missing = await request(app)
      .post('/api/agent/workflow/wf_nope_missing/cancel')
      .set({ Authorization: `Bearer ${u.token}` })
      .send({});
    expect(missing.status).toBe(404);

    const cancelled = await request(app)
      .post(`/api/agent/workflow/${wf.id}/cancel`)
      .set({ Authorization: `Bearer ${u.token}` })
      .send({ reason: 'Changed my mind' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const again = await request(app)
      .post(`/api/agent/workflow/${wf.id}/cancel`)
      .set({ Authorization: `Bearer ${u.token}` })
      .send({});
    expect(again.status).toBe(409);

    // A completed (paid) mission cannot be cancelled away.
    const done = await relayOrchestrator.startWorkflow({
      requestText: '3 kg sugar',
      residentReference: u.residentId,
      societyReference: u.societyId,
    });
    expect(done.status).toBe('COMPLETED');
    const paidCancel = await request(app)
      .post(`/api/agent/workflow/${done.id}/cancel`)
      .set({ Authorization: `Bearer ${u.token}` })
      .send({});
    expect(paidCancel.status).toBe(409);
    expect(paidCancel.body.error.code).toBe('CANCELLATION_REJECTED_AFTER_PAYMENT');
  });

  it('D. failed runs never emit backend victory text', async () => {
    // A foreign society is refused outright: no run, no victory text.
    const u = await onboardFreshUser({
      emailPrefix: 'fail.text',
      societyName: 'Failure Text Residency',
      mandateLimit: 1,
    });
    createdSocieties.push(u.societyId);
    const foreign = await request(app)
      .post('/api/agent/run')
      .set({ Authorization: `Bearer ${u.token}` })
      .send({ message: 'I need 2 kg of raw groundnuts', societyId: 'soc_nope_missing' });
    expect(foreign.status).toBe(403);

    // An in-scope failure (mandate cannot cover the order) must still read
    // as a failure, never as a secured purchase.
    const failed = await request(app)
      .post('/api/agent/run')
      .set({ Authorization: `Bearer ${u.token}` })
      .send({ message: 'I need 2 kg of raw groundnuts' });
    expect(failed.status).toBe(200);
    expect(failed.body.response).toContain('could not complete');
    expect(failed.body.response).not.toContain('has been secured');
  });
});
