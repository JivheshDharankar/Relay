import request from 'supertest';
import { expect } from 'vitest';
import { randomUUID } from 'crypto';
import { app } from '../../src/app';

// Test DATA coordinates near Baner, Pune — inside the seeded suppliers'
// service radii (Sahyadri 15km, Deccan 20km). This reflects backend geography
// capability; the helper itself references no city-specific behavior.
const NEAR_BANER = { latitude: 18.5601, longitude: 73.7801 };

export interface FreshUser {
  email: string;
  token: string;
  userId: string;
  residentId: string;
  societyId: string;
}

/**
 * Drives the legitimate public path: OTP auth -> profile -> address ->
 * society register+join -> verify -> mandate. No seeds, no bypasses.
 * Mirrors the fixture proven by fresh-user-lifecycle.test.ts.
 */
export async function onboardFreshUser(opts: {
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

  const verifySocRes = await request(app)
    .post('/api/onboarding/verify-society')
    .set(auth)
    .send({ attestResidence: true });
  expect(verifySocRes.status).toBe(200);

  const mandateRes = await request(app).post('/api/onboarding/payment-mandate').set(auth).send({
    spendingLimit: opts.mandateLimit,
    currency: 'INR',
  });
  expect(mandateRes.status).toBe(200);
  expect(mandateRes.body.data.isComplete).toBe(true);

  return { email, token, userId, residentId, societyId };
}
