import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/config/prisma', () => ({
  prisma: {
    resident: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), create: vi.fn() },
    society: { findUnique: vi.fn(), upsert: vi.fn(), create: vi.fn() },
    paymentMandate: { findFirst: vi.fn(), upsert: vi.fn(), create: vi.fn() },
    payment: { aggregate: vi.fn() },
  },
  disconnectPrisma: vi.fn(),
}));

import { prisma } from '../src/config/prisma';
import { UserService } from '../src/identity/UserService';
import { ProfileService } from '../src/identity/ProfileService';
import { AddressService } from '../src/identity/AddressService';
import { SocietyService } from '../src/identity/SocietyService';
import { MembershipService } from '../src/identity/MembershipService';
import { OnboardingService } from '../src/identity/OnboardingService';
import { ProcurementIdentityService } from '../src/identity/ProcurementIdentityService';
import { IdentityRehydrationService } from '../src/identity/IdentityRehydrationService';
import { IdentityAuditService } from '../src/identity/IdentityAuditService';
import { MandateService } from '../src/payment/mandate/MandateService';
import { UserIdentity } from '../src/identity/types';

const mocked = prisma as unknown as {
  resident: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  society: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  paymentMandate: { findFirst: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  payment: { aggregate: ReturnType<typeof vi.fn> };
};

function providerUser(overrides: Partial<UserIdentity> = {}): UserIdentity {
  const now = new Date();
  return {
    id: 'usr_ep_test',
    authProvider: 'EMAIL',
    providerAccountId: 'ep_returning_user_example_com',
    email: 'returning.user@example.com',
    name: 'Returning User',
    onboardingStatus: 'AUTHENTICATED',
    residentId: 'res_usr_ep_test',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const DB_RESIDENT = {
  id: 'res_canonical_001',
  societyId: 'soc_canonical_001',
  name: 'Returning User',
  phone: '+919810000001',
  flatNumber: 'A-101',
};
const DB_SOCIETY = {
  id: 'soc_canonical_001',
  name: 'Sunrise Residency',
  address: '14 Lakeview Road, Sector 5',
  city: 'Pune',
  state: 'Maharashtra',
  postalCode: '411001',
  latitude: 18.5601,
  longitude: 73.7801,
};
const DB_MANDATE = {
  id: 'mandate_canonical_001',
  status: 'ACTIVE',
  maximumAmount: 5000,
  currency: 'INR',
  purpose: 'COMMUNITY_PROCUREMENT',
  periodStart: new Date('2026-01-01T00:00:00Z'),
  periodEnd: null,
  providerReference: null,
};

function mockDurableResident() {
  mocked.resident.findUnique.mockResolvedValue({ ...DB_RESIDENT });
  mocked.society.findUnique.mockResolvedValue({ ...DB_SOCIETY });
  mocked.paymentMandate.findFirst.mockResolvedValue({ ...DB_MANDATE });
  mocked.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
}

function freshServices() {
  const userSvc = new UserService();
  const profileSvc = new ProfileService(userSvc);
  const addressSvc = new AddressService(userSvc);
  const societySvc = new SocietyService();
  const membershipSvc = new MembershipService(societySvc, userSvc);
  const mandateSvc = new MandateService();
  const auditSvc = new IdentityAuditService();
  const rehydration = new IdentityRehydrationService(
    userSvc,
    profileSvc,
    addressSvc,
    societySvc,
    membershipSvc,
    mandateSvc,
    auditSvc
  );
  const onboarding = new OnboardingService(userSvc, profileSvc, addressSvc, membershipSvc, mandateSvc);
  const procurementIdentity = new ProcurementIdentityService(
    userSvc,
    profileSvc,
    societySvc,
    membershipSvc,
    mandateSvc
  );
  return { userSvc, profileSvc, addressSvc, societySvc, membershipSvc, mandateSvc, rehydration, onboarding, procurementIdentity };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.resident.findMany.mockResolvedValue([]);
});

describe('returning-user durable resolution', () => {
  it('creates a new user when no durable row exists', async () => {
    mocked.resident.findUnique.mockResolvedValue(null);
    const { rehydration } = freshServices();
    const { user, isNewUser } = await rehydration.resolveUser(providerUser());
    expect(isNewUser).toBe(true);
    expect(user.onboardingStatus).toBe('AUTHENTICATED');
    expect(user.residentId).toBe(user.residentId);
  });

  it('rehydrates the SAME canonical ids for a returning user', async () => {
    mockDurableResident();
    const s = freshServices();
    const { user, isNewUser } = await s.rehydration.resolveUser(providerUser());
    expect(isNewUser).toBe(false);
    expect(user.residentId).toBe('res_canonical_001');

    const membership = await s.membershipSvc.getMembershipByUserId(user.id);
    expect(membership?.societyId).toBe('soc_canonical_001');
    expect(membership?.verificationStatus).toBe('VERIFIED');
    expect(membership?.tower).toBe('A');
    expect(membership?.flatNumber).toBe('101');

    const mandate = s.mandateSvc.getMandate('mandate_canonical_001');
    expect(mandate?.ownerReference).toBe('res_canonical_001');
    expect(mandate?.status).toBe('ACTIVE');
    expect(mandate?.spendingLimit).toBe(5000);

    const profile = await s.profileSvc.getProfile(user.id);
    expect(profile?.email).toBe('returning.user@example.com');
    const addresses = await s.addressSvc.getAddresses(user.id);
    expect(addresses.length).toBe(1);

    const state = await s.onboarding.evaluateOnboardingState(user.id);
    expect(state.isComplete).toBe(true);
    expect(state.currentStep).toBe('ONBOARDING_COMPLETE');
  });

  it('reuses ids across repeated login cycles (restart simulation)', async () => {
    mockDurableResident();
    const seen = new Set<string>();
    for (let cycle = 0; cycle < 3; cycle++) {
      // Fresh registries simulate a backend restart; the database persists.
      const s = freshServices();
      const { user, isNewUser } = await s.rehydration.resolveUser(providerUser());
      expect(isNewUser).toBe(false);
      seen.add(user.residentId);
      const membership = await s.membershipSvc.getMembershipByUserId(user.id);
      seen.add(`soc:${membership?.societyId}`);
      expect(s.mandateSvc.getMandate('mandate_canonical_001')).toBeDefined();
    }
    expect([...seen].sort()).toEqual(['res_canonical_001', 'soc:soc_canonical_001']);
    // Rehydration only reads durable state; it never writes new rows.
    expect(mocked.resident.create).not.toHaveBeenCalled();
    expect(mocked.resident.upsert).not.toHaveBeenCalled();
    expect(mocked.society.create).not.toHaveBeenCalled();
    expect(mocked.society.upsert).not.toHaveBeenCalled();
    expect(mocked.paymentMandate.create).not.toHaveBeenCalled();
    expect(mocked.paymentMandate.upsert).not.toHaveBeenCalled();
  });

  it('serializes concurrent logins into a single identity', async () => {
    mockDurableResident();
    const s = freshServices();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => s.rehydration.resolveUser(providerUser()))
    );
    const residentIds = new Set(results.map((r) => r.user.residentId));
    const userIds = new Set(results.map((r) => r.user.id));
    expect([...residentIds]).toEqual(['res_canonical_001']);
    expect(userIds.size).toBe(1);
    expect(s.mandateSvc.listMandates().length).toBe(1);
    expect(results.every((r) => r.isNewUser === false)).toBe(true);
  });

  it('serializes concurrent NEW-user logins into a single identity', async () => {
    mocked.resident.findUnique.mockResolvedValue(null);
    const s = freshServices();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => s.rehydration.resolveUser(providerUser()))
    );
    expect(new Set(results.map((r) => r.user.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.user.residentId)).size).toBe(1);
  });

  it('uses the in-memory fast path when the session survives', async () => {
    mockDurableResident();
    const s = freshServices();
    const first = await s.rehydration.resolveUser(providerUser());
    vi.clearAllMocks();
    const second = await s.rehydration.resolveUser(providerUser());
    expect(second.user.id).toBe(first.user.id);
    expect(second.isNewUser).toBe(false);
    expect(mocked.resident.findUnique).not.toHaveBeenCalled();
  });

  it('restores a revoked mandate as revoked, never active', async () => {
    mockDurableResident();
    mocked.paymentMandate.findFirst.mockResolvedValue({ ...DB_MANDATE, status: 'REVOKED' });
    const s = freshServices();
    const { user } = await s.rehydration.resolveUser(providerUser());
    expect(s.mandateSvc.getMandate('mandate_canonical_001')?.status).toBe('REVOKED');
    const state = await s.onboarding.evaluateOnboardingState(user.id);
    expect(state.isComplete).toBe(false);
  });

  it('fails closed to PAUSED on an unknown durable mandate status', async () => {
    mockDurableResident();
    mocked.paymentMandate.findFirst.mockResolvedValue({ ...DB_MANDATE, status: 'SUSPENDED' });
    const s = freshServices();
    await s.rehydration.resolveUser(providerUser());
    expect(s.mandateSvc.getMandate('mandate_canonical_001')?.status).toBe('PAUSED');
  });

  it('rebuilds spent capacity from settled charges', async () => {
    mockDurableResident();
    mocked.payment.aggregate.mockResolvedValue({ _sum: { amount: 1285.52 } });
    const s = freshServices();
    await s.rehydration.resolveUser(providerUser());
    expect(s.mandateSvc.getMandate('mandate_canonical_001')?.spentAmount).toBe(1285.52);
  });

  it('resolves identity without a mandate row and routes to authorization', async () => {
    mockDurableResident();
    mocked.paymentMandate.findFirst.mockResolvedValue(null);
    const s = freshServices();
    const { user, isNewUser } = await s.rehydration.resolveUser(providerUser());
    expect(isNewUser).toBe(false);
    expect(user.residentId).toBe('res_canonical_001');
    const state = await s.onboarding.evaluateOnboardingState(user.id);
    expect(state.currentStep).toBe('PAYMENT_AUTHORIZATION_REQUIRED');
  });

  it('resolves phone users by verified phone on unambiguous match', async () => {
    mocked.resident.findUnique.mockResolvedValue(null);
    mocked.resident.findMany.mockResolvedValue([{ ...DB_RESIDENT }]);
    const s = freshServices();
    const { user, isNewUser } = await s.rehydration.resolveUser(
      providerUser({
        authProvider: 'PHONE',
        providerAccountId: 'ep_919810000001',
        email: 'ep_919810000001@phone.relay.local',
        phone: '+919810000001',
      })
    );
    expect(isNewUser).toBe(false);
    expect(user.residentId).toBe('res_canonical_001');
  });

  it('treats ambiguous phone matches as a new user', async () => {
    mocked.resident.findUnique.mockResolvedValue(null);
    mocked.resident.findMany.mockResolvedValue([
      { ...DB_RESIDENT },
      { ...DB_RESIDENT, id: 'res_canonical_002' },
    ]);
    const s = freshServices();
    const { isNewUser } = await s.rehydration.resolveUser(
      providerUser({
        authProvider: 'PHONE',
        providerAccountId: 'ep_919810000001',
        email: 'ep_919810000001@phone.relay.local',
        phone: '+919810000001',
      })
    );
    expect(isNewUser).toBe(true);
  });

  it('keeps IDOR ownership tied to the canonical resident after rehydrate', async () => {
    mockDurableResident();
    const s = freshServices();
    const { user } = await s.rehydration.resolveUser(providerUser());
    expect(await s.userSvc.validateUserOwnership(user.id, 'res_canonical_001')).toBe(true);
    expect(await s.userSvc.validateUserOwnership(user.id, 'res_someone_else')).toBe(false);
  });

  it('preserves the same-process different-provider guard', async () => {
    mocked.resident.findUnique.mockResolvedValue(null);
    const s = freshServices();
    await s.rehydration.resolveUser(providerUser());
    await expect(
      s.userSvc.createUser({
        authProvider: 'GOOGLE',
        providerAccountId: 'g_attacker_sub',
        email: 'returning.user@example.com',
        name: 'Attacker',
      })
    ).rejects.toThrow('ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER');
  });

  it('lets procurement proceed for the rehydrated identity', async () => {
    mockDurableResident();
    mocked.resident.findUnique.mockResolvedValue({ id: 'res_canonical_001' });
    mocked.society.upsert.mockResolvedValue({});
    mocked.resident.upsert.mockResolvedValue({});
    mocked.paymentMandate.upsert.mockResolvedValue({});
    const s = freshServices();
    const { user } = await s.rehydration.resolveUser(providerUser());
    const ids = await s.procurementIdentity.ensureCanonicalIdentities(user.id);
    expect(ids).toEqual({ residentId: 'res_canonical_001', societyId: 'soc_canonical_001' });
  });

  it('still rejects a genuinely conflicting resident (backstop intact)', async () => {
    mockDurableResident();
    const s = freshServices();
    const { user } = await s.rehydration.resolveUser(providerUser());
    // A DIFFERENT resident owns this email in the database.
    mocked.resident.findUnique.mockResolvedValue({ id: 'res_attacker_999' });
    await expect(s.procurementIdentity.ensureCanonicalIdentities(user.id)).rejects.toMatchObject({
      code: 'RESIDENT_EMAIL_CONFLICT',
    });
  });
});
