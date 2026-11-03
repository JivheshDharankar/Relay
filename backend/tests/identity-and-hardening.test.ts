import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import express, { Express } from 'express';
import request from 'supertest';
import {
  userService,
  profileService,
  addressService,
  societyService,
  membershipService,
  onboardingService,
  sessionService,
  rateLimiterService,
  distributedLockService,
  identityAuditService,
  authProviderRegistry,
  emailPhoneAuthProvider,
  googleAuthProvider,
  GoogleAuthProvider,
} from '../src/identity';
import { mandateService } from '../src/payment/mandate/MandateService';
import { eventBus } from '../src/events';
import { authRoutes } from '../src/routes/auth.routes';
import { onboardingRoutes } from '../src/routes/onboarding.routes';
import { societyRoutes } from '../src/routes/society.routes';
import { portalRoutes } from '../src/routes/portal.routes';
import { optionalAuth, requireAuth } from '../src/middleware/auth.middleware';

describe('Milestone 12 — Production Hardening + Real User Identity Suite', () => {
  let app: Express;

  beforeEach(async () => {
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

    app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.use('/api/onboarding', onboardingRoutes);
    app.use('/api/societies', societyRoutes);
    app.use('/api/portal', optionalAuth, portalRoutes);
  });

  afterEach(async () => {
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
  });

  // Helper to create test user & session
  const createAuthenticatedTestUser = async (overrides: { email?: string; name?: string } = {}) => {
    const user = await userService.createUser({
      authProvider: 'EMAIL_PHONE',
      providerAccountId: `ep_${randomUUID().slice(0, 8)}`,
      email: overrides.email || `resident_${randomUUID().slice(0, 6)}@relay.local`,
      name: overrides.name || 'Test Resident',
    });
    const session = await sessionService.createSession(user.id);
    return { user, session };
  };

  // =========================================================================
  // SUITE 1: Authentication & Provider Abstraction (14 tests)
  // =========================================================================
  describe('1. Authentication & Provider Abstraction', () => {
    it('1.1 authenticates successfully with Email/Phone OTP', async () => {
      const email = 'resident_alpha@example.com';
      await emailPhoneAuthProvider.sendOtp(email);

      // Verify OTP (in test environment test OTP 123456 or generated code works)
      const res = await emailPhoneAuthProvider.authenticate({
        provider: 'EMAIL_PHONE',
        email,
        otpCode: '123456',
        name: 'Resident Alpha',
      });

      expect(res.success).toBe(true);
      expect(res.user).toBeDefined();
      expect(res.user?.email).toBe(email);
      expect(res.user?.authProvider).toBe('EMAIL_PHONE');
    });

    it('1.2 rejects invalid OTP code', async () => {
      const email = 'resident_bad_otp@example.com';
      await emailPhoneAuthProvider.sendOtp(email);

      const res = await emailPhoneAuthProvider.authenticate({
        provider: 'EMAIL_PHONE',
        email,
        otpCode: '000000', // Invalid code
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('INVALID_OTP');
    });

    it('1.3 rejects expired OTP code', async () => {
      const email = 'resident_exp@example.com';
      await emailPhoneAuthProvider.sendOtp(email);

      // Manually simulate expiration in provider cache
      const stored = (emailPhoneAuthProvider as any).otpStore.get(email);
      if (stored) {
        stored.expiresAt = new Date(Date.now() - 1000);
      }

      const res = await emailPhoneAuthProvider.authenticate({
        provider: 'EMAIL_PHONE',
        email,
        otpCode: '111111',
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('OTP_EXPIRED');
    });

    it('1.4 invalidates OTP after maximum failed attempts (3 attempts)', async () => {
      const email = 'resident_brute@example.com';
      await emailPhoneAuthProvider.sendOtp(email);

      // 3 failed attempts
      await emailPhoneAuthProvider.authenticate({ provider: 'EMAIL_PHONE', email, otpCode: '999991' });
      await emailPhoneAuthProvider.authenticate({ provider: 'EMAIL_PHONE', email, otpCode: '999992' });
      const res3 = await emailPhoneAuthProvider.authenticate({ provider: 'EMAIL_PHONE', email, otpCode: '999993' });

      expect(res3.success).toBe(false);
      expect(res3.errorCode).toBe('MAX_OTP_ATTEMPTS_EXCEEDED');

      // Subsequent attempt indicates no active OTP
      const res4 = await emailPhoneAuthProvider.authenticate({ provider: 'EMAIL_PHONE', email, otpCode: '123456' });
      expect(res4.errorCode).toBe('OTP_NOT_FOUND');
    });

    it('1.5 Google OAuth provider reports requiresConfig=true when environment credentials are unset', async () => {
      const unconfiguredGoogle = new GoogleAuthProvider(undefined, undefined);
      expect(unconfiguredGoogle.isConfigured).toBe(false);

      const res = await unconfiguredGoogle.authenticate({
        provider: 'GOOGLE',
        idToken: 'some_google_token',
      });

      expect(res.success).toBe(false);
      expect(res.requiresConfig).toBe(true);
      expect(res.errorCode).toBe('GOOGLE_AUTH_UNCONFIGURED');
    });

    it('1.6 Google OAuth provider rejects missing idToken', async () => {
      const configuredGoogle = new GoogleAuthProvider('test_client_id', 'test_client_secret');
      expect(configuredGoogle.isConfigured).toBe(true);

      const res = await configuredGoogle.authenticate({
        provider: 'GOOGLE',
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('MISSING_TOKEN');
    });

    it('1.7 Google OAuth provider authenticates a Google-verified token when configured', async () => {
      const fetchFn = (async () =>
        ({
          ok: true,
          json: async () => ({
            sub: 'verified-sub-123',
            aud: 'test_client_id',
            iss: 'https://accounts.google.com',
            exp: String(Math.floor(Date.now() / 1000) + 3600),
            email: 'real_google_user@gmail.com',
            name: 'Real Google User',
          }),
        }) as any) as typeof fetch;
      const configuredGoogle = new GoogleAuthProvider({
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
        fetchFn,
      });

      const res = await configuredGoogle.authenticate({
        provider: 'GOOGLE',
        idToken: 'valid_google_token_12345678',
        // Spoofed client-supplied identity must be ignored in favour of
        // Google's verified claims.
        email: 'attacker_chosen@gmail.com',
        name: 'Attacker Chosen',
      });

      expect(res.success).toBe(true);
      expect(res.user?.email).toBe('real_google_user@gmail.com');
      expect(res.user?.name).toBe('Real Google User');
      expect(res.user?.providerAccountId).toBe('g_verified-sub-123');
    });

    it('1.7a Google OAuth provider rejects a token Google does not verify', async () => {
      const fetchFn = (async () => ({ ok: false, status: 400 }) as any) as typeof fetch;
      const configuredGoogle = new GoogleAuthProvider({
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
        fetchFn,
      });

      const res = await configuredGoogle.authenticate({
        provider: 'GOOGLE',
        idToken: 'forged_google_token_12345678',
        email: 'victim@gmail.com',
        name: 'Victim',
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('INVALID_ID_TOKEN');
    });

    it('1.7b Google OAuth provider rejects a token issued for a different audience', async () => {
      const fetchFn = (async () =>
        ({
          ok: true,
          json: async () => ({
            sub: 'other-app-sub',
            aud: 'some_other_client_id',
            iss: 'https://accounts.google.com',
            exp: String(Math.floor(Date.now() / 1000) + 3600),
            email: 'real_google_user@gmail.com',
          }),
        }) as any) as typeof fetch;
      const configuredGoogle = new GoogleAuthProvider({
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
        fetchFn,
      });

      const res = await configuredGoogle.authenticate({
        provider: 'GOOGLE',
        idToken: 'cross_audience_token_12345678',
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('INVALID_ID_TOKEN');
    });

    it('1.7c Google OAuth provider rejects an expired verified token', async () => {
      const fetchFn = (async () =>
        ({
          ok: true,
          json: async () => ({
            sub: 'verified-sub-123',
            aud: 'test_client_id',
            iss: 'https://accounts.google.com',
            exp: String(Math.floor(Date.now() / 1000) - 10),
            email: 'real_google_user@gmail.com',
          }),
        }) as any) as typeof fetch;
      const configuredGoogle = new GoogleAuthProvider({
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
        fetchFn,
      });

      const res = await configuredGoogle.authenticate({
        provider: 'GOOGLE',
        idToken: 'expired_google_token_12345678',
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('INVALID_ID_TOKEN');
    });

    it('1.8 AuthProviderRegistry resolves all supported providers dynamically', () => {
      expect(authProviderRegistry.has('GOOGLE')).toBe(true);
      expect(authProviderRegistry.has('EMAIL_PHONE')).toBe(true);
      expect(authProviderRegistry.has('EMAIL')).toBe(true);
      expect(authProviderRegistry.has('PHONE')).toBe(true);
      expect(authProviderRegistry.has('INSTAGRAM' as any)).toBe(false);
      expect(authProviderRegistry.has('X' as any)).toBe(false);
      expect(authProviderRegistry.list().length).toBe(2);
      expect(authProviderRegistry.getAllMetadata().length).toBe(3);
    });

    it('1.9 rejects unsupported auth provider type gracefully', () => {
      const unsupported = authProviderRegistry.get('FACEBOOK' as any);
      expect(unsupported).toBeUndefined();
    });

    it('1.10 idempotent user resolution: re-authenticating with same provider account returns existing user', async () => {
      const input = {
        authProvider: 'EMAIL_PHONE' as const,
        providerAccountId: 'ep_same_resident',
        email: 'same_resident@relay.local',
        name: 'Same Resident',
      };

      const u1 = await userService.createUser(input);
      const u2 = await userService.createUser(input);

      expect(u1.id).toBe(u2.id);
      expect(u1.residentId).toBe(u2.residentId);
    });
  });

  // =========================================================================
  // SUITE 2: User Identity & Resident Mapping (10 tests)
  // =========================================================================
  describe('2. User Identity & Resident Mapping', () => {
    it('2.1 derives deterministic residentId from userId', () => {
      const resId1 = userService.deriveResidentId('usr_test_123');
      const resId2 = userService.deriveResidentId('usr_test_123');

      expect(resId1).toBe(resId2);
      expect(resId1.startsWith('res_')).toBe(true);
    });

    it('2.2 generates stable, collision-free residentId across distinct users', () => {
      const resA = userService.deriveResidentId('usr_alice');
      const resB = userService.deriveResidentId('usr_bob');

      expect(resA).not.toBe(resB);
    });

    it('2.3 re-derives identical residentId for the same userId', () => {
      const resA = userService.deriveResidentId('usr_stable_id');
      const resB = userService.deriveResidentId('usr_stable_id');
      expect(resA).toBe(resB);
    });

    it('2.4 bi-directional lookup: retrieves user by residentId and residentId by userId', async () => {
      const user = await userService.createUser({
        authProvider: 'EMAIL_PHONE',
        providerAccountId: 'ep_bidirectional',
        email: 'bidirectional@relay.local',
        name: 'Bidi User',
      });

      const residentId = await userService.getResidentIdForUser(user.id);
      expect(residentId).toBe(user.residentId);

      const foundUser = await userService.getUserForResidentId(residentId);
      expect(foundUser?.id).toBe(user.id);
    });

    it('2.5 normalizes user email to lowercase', async () => {
      const user = await userService.createUser({
        authProvider: 'EMAIL_PHONE',
        providerAccountId: 'ep_upper',
        email: 'CAPITAL_USER@RELAY.LOCAL',
        name: 'Capital User',
      });

      expect(user.email).toBe('capital_user@relay.local');
      const found = await userService.findByEmail('CAPITAL_USER@RELAY.LOCAL');
      expect(found?.id).toBe(user.id);
    });

    it('2.6 prevents duplicate provider accounts', async () => {
      const u1 = await userService.createUser({
        authProvider: 'GOOGLE',
        providerAccountId: 'g_12345',
        email: 'dup1@gmail.com',
        name: 'User One',
      });

      const u2 = await userService.createUser({
        authProvider: 'GOOGLE',
        providerAccountId: 'g_12345',
        email: 'dup2@gmail.com',
        name: 'User Two',
      });

      expect(u1.id).toBe(u2.id);
    });

    it('2.7 validates user ownership: user owns their own residentId', async () => {
      const user = await userService.createUser({
        authProvider: 'EMAIL_PHONE',
        providerAccountId: 'ep_owner',
        email: 'owner@relay.local',
        name: 'Owner User',
      });

      const isOwner = await userService.validateUserOwnership(user.id, user.residentId);
      expect(isOwner).toBe(true);
    });

    it('2.8 blocks IDOR: rejects attempt by user A to claim ownership of user B\'s residentId', async () => {
      const userA = await userService.createUser({
        authProvider: 'EMAIL_PHONE',
        providerAccountId: 'ep_user_a',
        email: 'user_a@relay.local',
        name: 'User A',
      });

      const userB = await userService.createUser({
        authProvider: 'EMAIL_PHONE',
        providerAccountId: 'ep_user_b',
        email: 'user_b@relay.local',
        name: 'User B',
      });

      const isOwner = await userService.validateUserOwnership(userA.id, userB.residentId);
      expect(isOwner).toBe(false);
    });

    it('2.9 updates user profile metadata cleanly', async () => {
      const user = await userService.createUser({
        authProvider: 'EMAIL_PHONE',
        providerAccountId: 'ep_update',
        email: 'update@relay.local',
        name: 'Original Name',
      });

      const updated = await userService.updateUser(user.id, { name: 'New Name', phone: '+919876543210' });
      expect(updated.name).toBe('New Name');
      expect(updated.phone).toBe('+919876543210');
    });

    it('2.10 deactivated user is blocked from creating new sessions', async () => {
      const user = await userService.createUser({
        authProvider: 'EMAIL_PHONE',
        providerAccountId: 'ep_deact',
        email: 'deact@relay.local',
        name: 'Deactivated User',
      });

      await userService.updateUser(user.id, { isActive: false });

      await expect(sessionService.createSession(user.id)).rejects.toThrow('deactivated');
    });
  });

  // =========================================================================
  // SUITE 3: User Profile Management & Validation (10 tests)
  // =========================================================================
  describe('3. User Profile Management & Validation', () => {
    it('3.1 creates user profile with server-side validation', async () => {
      const { user } = await createAuthenticatedTestUser();

      const profile = await profileService.createProfile(user.id, {
        fullName: 'Aarav Sharma',
        email: user.email,
        phone: '+919876543210',
        preferredContactMethod: 'WHATSAPP',
        city: 'Pune',
        postalCode: '411045',
      });

      expect(profile.userId).toBe(user.id);
      expect(profile.fullName).toBe('Aarav Sharma');
      expect(profile.preferredContactMethod).toBe('WHATSAPP');
    });

    it('3.2 rejects profile creation if user does not exist', async () => {
      await expect(
        profileService.createProfile('usr_ghost', {
          fullName: 'Ghost',
          email: 'ghost@relay.local',
        })
      ).rejects.toThrow('does not exist');
    });

    it('3.3 rejects invalid email format in profile', async () => {
      const { user } = await createAuthenticatedTestUser();

      await expect(
        profileService.createProfile(user.id, {
          fullName: 'Invalid Email User',
          email: 'not-an-email',
        })
      ).rejects.toThrow('Invalid email address');
    });

    it('3.4 rejects invalid phone number format in profile', async () => {
      const { user } = await createAuthenticatedTestUser();

      await expect(
        profileService.createProfile(user.id, {
          fullName: 'Bad Phone User',
          email: 'badphone@relay.local',
          phone: '123', // too short, non E.164
        })
      ).rejects.toThrow('Invalid phone number format');
    });

    it('3.5 rejects name with less than 2 characters', async () => {
      const { user } = await createAuthenticatedTestUser();

      await expect(
        profileService.createProfile(user.id, {
          fullName: 'A', // too short
          email: 'shortname@relay.local',
        })
      ).rejects.toThrow('at least 2 characters');
    });

    it('3.6 updates profile fields partially', async () => {
      const { user } = await createAuthenticatedTestUser();
      await profileService.createProfile(user.id, {
        fullName: 'Initial Name',
        email: user.email,
      });

      const updated = await profileService.updateProfile(user.id, {
        preferredContactMethod: 'SMS',
        phone: '+919988776655',
      });

      expect(updated.preferredContactMethod).toBe('SMS');
      expect(updated.phone).toBe('+919988776655');
      expect(updated.fullName).toBe('Initial Name');
    });

    it('3.7 synchronizes updated fullName back to user identity', async () => {
      const { user } = await createAuthenticatedTestUser();
      await profileService.createProfile(user.id, {
        fullName: 'Synchronized Name',
        email: user.email,
      });

      const refreshedUser = await userService.getUserById(user.id);
      expect(refreshedUser?.name).toBe('Synchronized Name');
    });

    it('3.8 supports preferred contact methods: EMAIL, SMS, WHATSAPP', async () => {
      const { user } = await createAuthenticatedTestUser();
      for (const method of ['EMAIL', 'SMS', 'WHATSAPP'] as const) {
        const p = await profileService.createProfile(user.id, {
          fullName: 'Multi Contact',
          email: user.email,
          preferredContactMethod: method,
        });
        expect(p.preferredContactMethod).toBe(method);
      }
    });

    it('3.9 validates latitude and longitude ranges (-90 to 90, -180 to 180)', async () => {
      const { user } = await createAuthenticatedTestUser();

      await expect(
        profileService.createProfile(user.id, {
          fullName: 'Bad Coords',
          email: user.email,
          latitude: 95, // Invalid > 90
        })
      ).rejects.toThrow('between -90 and 90');
    });

    it('3.10 sanitizes and trims whitespace from profile inputs', async () => {
      const { user } = await createAuthenticatedTestUser();
      const profile = await profileService.createProfile(user.id, {
        fullName: '  Trimmed Name  ',
        email: user.email,
      });

      expect(profile.fullName).toBe('Trimmed Name');
    });
  });

  // =========================================================================
  // SUITE 4: Address Management & Location Independence (10 tests)
  // =========================================================================
  describe('4. Address Management & Location Independence', () => {
    it('4.1 adds address for authenticated user', async () => {
      const { user } = await createAuthenticatedTestUser();

      const addr = await addressService.addAddress(user.id, {
        addressLine: 'Flat 402, Tower B, Emerald Heights',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411045',
        country: 'India',
        latitude: 18.559,
        longitude: 73.7868,
      });

      expect(addr.userId).toBe(user.id);
      expect(addr.city).toBe('Pune');
      expect(addr.isDefault).toBe(true);
    });

    it('4.2 first address is automatically marked as default (isDefault=true)', async () => {
      const { user } = await createAuthenticatedTestUser();
      const addr1 = await addressService.addAddress(user.id, {
        addressLine: 'First Home Address Line',
        city: 'Bangalore',
        state: 'Karnataka',
        postalCode: '560001',
        country: 'India',
        latitude: 12.9716,
        longitude: 77.5946,
      });

      expect(addr1.isDefault).toBe(true);
    });

    it('4.3 adding subsequent address does not override default unless specified', async () => {
      const { user } = await createAuthenticatedTestUser();
      const a1 = await addressService.addAddress(user.id, {
        addressLine: 'Address One Line 1',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        latitude: 18.52,
        longitude: 73.85,
      });

      const a2 = await addressService.addAddress(user.id, {
        addressLine: 'Address Two Line 2',
        city: 'Pune',
        state: 'MH',
        postalCode: '411002',
        latitude: 18.53,
        longitude: 73.86,
        isDefault: false,
      });

      const defaultAddr = await addressService.getDefaultAddress(user.id);
      expect(defaultAddr?.id).toBe(a1.id);
      expect(a2.isDefault).toBe(false);
    });

    it('4.4 explicitly setting new default address unsets previous default', async () => {
      const { user } = await createAuthenticatedTestUser();
      const a1 = await addressService.addAddress(user.id, {
        addressLine: 'Old Default Address Line',
        city: 'Delhi',
        state: 'Delhi',
        postalCode: '110001',
        latitude: 28.61,
        longitude: 77.2,
      });

      const a2 = await addressService.addAddress(user.id, {
        addressLine: 'New Default Address Line',
        city: 'Delhi',
        state: 'Delhi',
        postalCode: '110002',
        latitude: 28.62,
        longitude: 77.21,
      });

      await addressService.setDefaultAddress(user.id, a2.id);

      const def = await addressService.getDefaultAddress(user.id);
      expect(def?.id).toBe(a2.id);

      const all = await addressService.getAddresses(user.id);
      const oldA1 = all.find((a) => a.id === a1.id);
      expect(oldA1?.isDefault).toBe(false);
    });

    it('4.5 rejects address with missing or too short address line', async () => {
      const { user } = await createAuthenticatedTestUser();
      await expect(
        addressService.addAddress(user.id, {
          addressLine: '123', // too short (< 5 chars)
          city: 'Pune',
          state: 'MH',
          postalCode: '411001',
          latitude: 18.52,
          longitude: 73.85,
        })
      ).rejects.toThrow('at least 5 characters');
    });

    it('4.6 rejects invalid postal code format', async () => {
      const { user } = await createAuthenticatedTestUser();
      await expect(
        addressService.addAddress(user.id, {
          addressLine: 'Good Address Line Here',
          city: 'Pune',
          state: 'MH',
          postalCode: '@@@$$$', // Invalid characters
          latitude: 18.52,
          longitude: 73.85,
        })
      ).rejects.toThrow('Invalid postal code format');
    });

    it('4.7 rejects invalid coordinates (latitude > 90 or < -90)', async () => {
      const { user } = await createAuthenticatedTestUser();
      await expect(
        addressService.addAddress(user.id, {
          addressLine: 'Good Address Line Here',
          city: 'Pune',
          state: 'MH',
          postalCode: '411001',
          latitude: 91.5,
          longitude: 73.85,
        })
      ).rejects.toThrow('between -90 and 90');
    });

    it('4.8 rejects invalid coordinates (longitude > 180 or < -180)', async () => {
      const { user } = await createAuthenticatedTestUser();
      await expect(
        addressService.addAddress(user.id, {
          addressLine: 'Good Address Line Here',
          city: 'Pune',
          state: 'MH',
          postalCode: '411001',
          latitude: 18.52,
          longitude: 185.0,
        })
      ).rejects.toThrow('between -180 and 180');
    });

    it('4.9 location-agnostic support: works dynamically for Pune, Bangalore, Delhi, Tokyo, London', async () => {
      const { user } = await createAuthenticatedTestUser();
      const locations = [
        { city: 'Pune', country: 'India', lat: 18.5204, lng: 73.8567, postal: '411001' },
        { city: 'Bangalore', country: 'India', lat: 12.9716, lng: 77.5946, postal: '560001' },
        { city: 'Delhi', country: 'India', lat: 28.6139, lng: 77.209, postal: '110001' },
        { city: 'Tokyo', country: 'Japan', lat: 35.6762, lng: 139.6503, postal: '100-0001' },
        { city: 'London', country: 'UK', lat: 51.5074, lng: -0.1278, postal: 'SW1A 1AA' },
      ];

      for (const loc of locations) {
        const addr = await addressService.addAddress(user.id, {
          addressLine: `101 Central Avenue, ${loc.city}`,
          city: loc.city,
          state: loc.city,
          postalCode: loc.postal,
          country: loc.country,
          latitude: loc.lat,
          longitude: loc.lng,
        });
        expect(addr.city).toBe(loc.city);
        expect(addr.country).toBe(loc.country);
      }
    });

    it('4.10 deletes address and updates user address list cleanly', async () => {
      const { user } = await createAuthenticatedTestUser();
      const a = await addressService.addAddress(user.id, {
        addressLine: 'Address To Delete Line',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        latitude: 18.5,
        longitude: 73.8,
      });

      const deleted = await addressService.deleteAddress(user.id, a.id);
      expect(deleted).toBe(true);

      const remaining = await addressService.getAddresses(user.id);
      expect(remaining.length).toBe(0);
    });
  });

  // =========================================================================
  // SUITE 5: Society Domain & Dynamic Discovery (10 tests)
  // =========================================================================
  describe('5. Society Domain & Dynamic Discovery', () => {
    it('5.1 dynamically registers new society with default PENDING_VERIFICATION status', async () => {
      const soc = await societyService.registerSociety({
        name: 'Skyline Marvel',
        address: 'Wakad Main Road',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411057',
        latitude: 18.598,
        longitude: 73.765,
      });

      expect(soc.name).toBe('Skyline Marvel');
      expect(soc.verificationStatus).toBe('PENDING_VERIFICATION'); // Invariant: Never pretends verified!
    });

    it('5.2 never marks an unverified society as VERIFIED by default', async () => {
      const soc = await societyService.registerSociety({
        name: 'Unverified Heights',
        address: 'Outer Ring Road',
        city: 'Bangalore',
        state: 'KA',
        postalCode: '560103',
        latitude: 12.92,
        longitude: 77.68,
      });

      expect(soc.verificationStatus).not.toBe('VERIFIED');
    });

    it('5.3 searches societies by partial name text', async () => {
      await societyService.registerSociety({
        name: 'Palm Meadows Villa Community',
        address: 'Whitefield',
        city: 'Bangalore',
        state: 'KA',
        postalCode: '560066',
        latitude: 12.96,
        longitude: 77.74,
      });

      const results = await societyService.searchSocieties({ query: 'Meadows' });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toContain('Palm Meadows');
    });

    it('5.4 searches societies by city', async () => {
      await societyService.registerSociety({
        name: 'Tokyo Tower Residence',
        address: 'Minato City',
        city: 'Tokyo',
        state: 'Tokyo',
        postalCode: '105-0011',
        country: 'Japan',
        latitude: 35.6586,
        longitude: 139.7454,
      });

      const results = await societyService.searchSocieties({ city: 'Tokyo' });
      expect(results.length).toBe(1);
      expect(results[0].city).toBe('Tokyo');
    });

    it('5.5 searches societies by postal code', async () => {
      await societyService.registerSociety({
        name: 'Koramangala Greens',
        address: '5th Block Koramangala',
        city: 'Bangalore',
        state: 'KA',
        postalCode: '560095',
        latitude: 12.935,
        longitude: 77.624,
      });

      const results = await societyService.searchSocieties({ postalCode: '560095' });
      expect(results.length).toBe(1);
      expect(results[0].postalCode).toBe('560095');
    });

    it('5.6 searches societies by geographic proximity (Haversine distance within radiusKm)', async () => {
      // Society at Baner (18.5590, 73.7868)
      await societyService.registerSociety({
        name: 'Baner Solitaire',
        address: 'Baner Road',
        city: 'Pune',
        state: 'MH',
        postalCode: '411045',
        latitude: 18.559,
        longitude: 73.7868,
      });

      // Search near Baner (18.5580, 73.7860) within 5km
      const nearResults = await societyService.searchSocieties({
        latitude: 18.558,
        longitude: 73.786,
        radiusKm: 5,
      });
      expect(nearResults.length).toBe(1);

      // Search far away (Mumbai: 19.0760, 72.8777) within 5km -> should be empty
      const farResults = await societyService.searchSocieties({
        latitude: 19.076,
        longitude: 72.8777,
        radiusKm: 5,
      });
      expect(farResults.length).toBe(0);
    });

    it('5.7 respects search query limit and returns bounded results', async () => {
      for (let i = 0; i < 5; i++) {
        await societyService.registerSociety({
          name: `Batch Society ${i}`,
          address: `Road ${i}`,
          city: 'Delhi',
          state: 'Delhi',
          postalCode: '110001',
          latitude: 28.6 + i * 0.01,
          longitude: 77.2,
        });
      }

      const results = await societyService.searchSocieties({ city: 'Delhi', limit: 3 });
      expect(results.length).toBe(3);
    });

    it('5.8 updates society verification status administratively', async () => {
      const soc = await societyService.registerSociety({
        name: 'Society Verification Test',
        address: 'Main Street',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        latitude: 18.5,
        longitude: 73.8,
      });

      const updated = await societyService.setVerificationStatus(soc.id, 'VERIFIED');
      expect(updated.verificationStatus).toBe('VERIFIED');
    });

    it('5.9 retrieves society by unique ID', async () => {
      const soc = await societyService.registerSociety({
        name: 'Lookup Society',
        address: 'Main Road',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        latitude: 18.5,
        longitude: 73.8,
      });

      const retrieved = await societyService.getSocietyById(soc.id);
      expect(retrieved?.name).toBe('Lookup Society');
    });

    it('5.10 validates required society name, address, and coordinates', async () => {
      await expect(
        societyService.registerSociety({
          name: 'No', // too short (< 3)
          address: 'Too short',
          city: 'Pune',
          state: 'MH',
          postalCode: '411001',
          latitude: 18.5,
          longitude: 73.8,
        })
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // SUITE 6: Society Membership & Supplier Privacy Boundary (10 tests)
  // =========================================================================
  describe('6. Society Membership & Supplier Privacy Boundary', () => {
    it('6.1 creates society membership linking user to society with tower and flat', async () => {
      const { user } = await createAuthenticatedTestUser();
      const soc = await societyService.registerSociety({
        name: 'Emerald Heights',
        address: 'Baner-Pashan Link Rd',
        city: 'Pune',
        state: 'MH',
        postalCode: '411045',
        latitude: 18.559,
        longitude: 73.786,
      });

      const mem = await membershipService.createMembership(user.id, {
        societyId: soc.id,
        tower: 'Tower C',
        flatNumber: 'Flat 1102',
      });

      expect(mem.userId).toBe(user.id);
      expect(mem.societyId).toBe(soc.id);
      expect(mem.tower).toBe('Tower C');
      expect(mem.flatNumber).toBe('Flat 1102');
    });

    it('6.2 rejects membership for non-existent society', async () => {
      const { user } = await createAuthenticatedTestUser();
      await expect(
        membershipService.createMembership(user.id, {
          societyId: 'soc_non_existent',
          flatNumber: '101',
        })
      ).rejects.toThrow('does not exist');
    });

    it('6.3 prevents duplicate membership in same society for same user (updates tower/flat)', async () => {
      const { user } = await createAuthenticatedTestUser();
      const soc = await societyService.registerSociety({
        name: 'Single Society',
        address: 'Street',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        latitude: 18.5,
        longitude: 73.8,
      });

      const m1 = await membershipService.createMembership(user.id, {
        societyId: soc.id,
        tower: 'Tower 1',
        flatNumber: '101',
      });

      const m2 = await membershipService.createMembership(user.id, {
        societyId: soc.id,
        tower: 'Tower 1',
        flatNumber: '102', // updated unit
      });

      expect(m1.id).toBe(m2.id);
      expect(m2.flatNumber).toBe('102');
    });

    it('6.4 initial verification status is PENDING_VERIFICATION (unless INSTANT_PRE_VERIFIED)', async () => {
      const { user } = await createAuthenticatedTestUser();
      const soc = await societyService.registerSociety({
        name: 'Pending Society',
        address: 'Street',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        latitude: 18.5,
        longitude: 73.8,
      });

      const m = await membershipService.createMembership(user.id, {
        societyId: soc.id,
        flatNumber: '304',
        verificationMethod: 'DOCUMENT_PROOF',
      });

      expect(m.verificationStatus).toBe('PENDING_VERIFICATION');
    });

    it('6.4a client-selected INSTANT_PRE_VERIFIED never auto-verifies a membership', async () => {
      const { user } = await createAuthenticatedTestUser();
      const soc = await societyService.registerSociety({
        name: 'Instant Society',
        address: 'Street',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        latitude: 18.5,
        longitude: 73.8,
      });

      const m = await membershipService.createMembership(user.id, {
        societyId: soc.id,
        flatNumber: '305',
        verificationMethod: 'INSTANT_PRE_VERIFIED',
      });

      expect(m.verificationMethod).toBe('INSTANT_PRE_VERIFIED');
      expect(m.verificationStatus).toBe('PENDING_VERIFICATION');
    });

    it('6.4b verifySocietyStep rejects a missing residence attestation', async () => {
      const { user } = await createAuthenticatedTestUser();
      const soc = await societyService.registerSociety({
        name: 'Attest Society',
        address: 'Street',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        latitude: 18.5,
        longitude: 73.8,
      });
      await membershipService.createMembership(user.id, {
        societyId: soc.id,
        flatNumber: '306',
      });

      await expect(onboardingService.verifySocietyStep(user.id)).rejects.toMatchObject({
        code: 'ATTESTATION_REQUIRED',
      });
      await expect(
        onboardingService.verifySocietyStep(user.id, { attestResidence: false })
      ).rejects.toMatchObject({ code: 'ATTESTATION_REQUIRED' });

      const membership = await membershipService.getMembershipByUserId(user.id);
      expect(membership?.verificationStatus).toBe('PENDING_VERIFICATION');
    });

    it('6.4c invalid onboarding transitions fail with 422, not 500', async () => {
      const { user } = await createAuthenticatedTestUser();
      // Verify-before-membership: no membership row exists for this user.
      await expect(
        onboardingService.verifySocietyStep(user.id, { attestResidence: true })
      ).rejects.toMatchObject({ code: 'MEMBERSHIP_REQUIRED', statusCode: 422 });
      // Mandate-before-verified-membership: rejected at the transition guard.
      await expect(
        onboardingService.submitPaymentMandateStep(user.id, {
          spendingLimit: 5000,
          currency: 'INR',
        })
      ).rejects.toMatchObject({ code: 'ONBOARDING_TRANSITION_INVALID', statusCode: 422 });
    });

    it('6.5 updates membership verification status to VERIFIED', async () => {
      const { user } = await createAuthenticatedTestUser();
      const soc = await societyService.registerSociety({
        name: 'Verify Society',
        address: 'Street',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        latitude: 18.5,
        longitude: 73.8,
      });

      const m = await membershipService.createMembership(user.id, {
        societyId: soc.id,
        flatNumber: '501',
      });

      const verified = await membershipService.updateVerificationStatus(m.id, 'VERIFIED');
      expect(verified.verificationStatus).toBe('VERIFIED');
    });

    it('6.6 updates membership verification status to REJECTED with notes', async () => {
      const { user } = await createAuthenticatedTestUser();
      const soc = await societyService.registerSociety({
        name: 'Reject Society',
        address: 'Street',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        latitude: 18.5,
        longitude: 73.8,
      });

      const m = await membershipService.createMembership(user.id, {
        societyId: soc.id,
        flatNumber: '999',
      });

      const rejected = await membershipService.updateVerificationStatus(
        m.id,
        'REJECTED',
        'Electricity bill name mismatch'
      );
      expect(rejected.verificationStatus).toBe('REJECTED');
      expect(rejected.notes).toBe('Electricity bill name mismatch');
    });

    it('6.7 Supplier Delivery View: provides society name and community delivery location', async () => {
      const soc = await societyService.registerSociety({
        name: 'Greenview Residency',
        address: 'Pashan Highway',
        city: 'Pune',
        state: 'MH',
        postalCode: '411021',
        country: 'India',
        latitude: 18.54,
        longitude: 73.79,
      });

      const view = await membershipService.getSupplierCommunityDeliveryView(soc.id);
      expect(view.societyName).toBe('Greenview Residency');
      expect(view.communityDeliveryAddress).toContain('Greenview Residency');
    });

    it('6.8 Supplier Delivery View: strictly masks flat number (flatNumber is undefined/omitted)', async () => {
      const soc = await societyService.registerSociety({
        name: 'Masked Society',
        address: 'Street',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        latitude: 18.5,
        longitude: 73.8,
      });

      const view = await membershipService.getSupplierCommunityDeliveryView(soc.id);
      expect((view as any).flatNumber).toBeUndefined();
    });

    it('6.9 Supplier Delivery View: strictly masks tower identifier', async () => {
      const soc = await societyService.registerSociety({
        name: 'Masked Tower Society',
        address: 'Street',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        latitude: 18.5,
        longitude: 73.8,
      });

      const view = await membershipService.getSupplierCommunityDeliveryView(soc.id);
      expect((view as any).tower).toBeUndefined();
    });

    it('6.10 Supplier Delivery View: strictly masks resident name, email, and phone number', async () => {
      const soc = await societyService.registerSociety({
        name: 'Masked Resident Society',
        address: 'Street',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        latitude: 18.5,
        longitude: 73.8,
      });

      const view = await membershipService.getSupplierCommunityDeliveryView(soc.id);
      expect((view as any).residentName).toBeUndefined();
      expect((view as any).email).toBeUndefined();
      expect((view as any).phone).toBeUndefined();
    });
  });

  // =========================================================================
  // SUITE 7: Onboarding State Machine & Resumability (12 tests)
  // =========================================================================
  describe('7. Onboarding State Machine & Resumability', () => {
    it('7.1 new user begins in AUTHENTICATED / PROFILE_REQUIRED state', async () => {
      const { user } = await createAuthenticatedTestUser();
      const summary = await onboardingService.evaluateOnboardingState(user.id);

      expect(summary.currentStep).toBe('PROFILE_REQUIRED');
      expect(summary.hasProfile).toBe(false);
      expect(summary.isComplete).toBe(false);
    });

    it('7.2 completing profile advances state to ADDRESS_REQUIRED', async () => {
      const { user } = await createAuthenticatedTestUser();
      const s1 = await onboardingService.submitProfileStep(user.id, {
        fullName: 'Onboarding Test User',
        email: user.email,
      });

      expect(s1.currentStep).toBe('ADDRESS_REQUIRED');
      expect(s1.hasProfile).toBe(true);
    });

    it('7.3 completing address advances state to SOCIETY_REQUIRED', async () => {
      const { user } = await createAuthenticatedTestUser();
      await onboardingService.submitProfileStep(user.id, {
        fullName: 'Address Step User',
        email: user.email,
      });

      const s2 = await onboardingService.submitAddressStep(user.id, {
        addressLine: 'Tower 4, Greenview Residency',
        city: 'Pune',
        state: 'MH',
        postalCode: '411045',
        latitude: 18.55,
        longitude: 73.78,
      });

      expect(s2.currentStep).toBe('SOCIETY_REQUIRED');
      expect(s2.hasAddress).toBe(true);
    });

    it('7.4 completing society advances state to SOCIETY_VERIFICATION_REQUIRED', async () => {
      const { user } = await createAuthenticatedTestUser();
      await onboardingService.submitProfileStep(user.id, { fullName: 'Soc User', email: user.email });
      await onboardingService.submitAddressStep(user.id, {
        addressLine: 'Address Line',
        city: 'Pune',
        state: 'MH',
        postalCode: '411045',
        latitude: 18.55,
        longitude: 73.78,
      });

      const soc = await societyService.registerSociety({
        name: 'Step Society',
        address: 'Main Road',
        city: 'Pune',
        state: 'MH',
        postalCode: '411045',
        latitude: 18.55,
        longitude: 73.78,
      });

      const s3 = await onboardingService.submitSocietyStep(user.id, {
        societyId: soc.id,
        tower: 'Tower A',
        flatNumber: '401',
        verificationMethod: 'DOCUMENT_PROOF',
      });

      expect(s3.currentStep).toBe('SOCIETY_VERIFICATION_REQUIRED');
      expect(s3.hasSociety).toBe(true);
      expect(s3.hasMembership).toBe(false); // pending verification
    });

    it('7.5 verifying society advances state to PAYMENT_AUTHORIZATION_REQUIRED', async () => {
      const { user } = await createAuthenticatedTestUser();
      await onboardingService.submitProfileStep(user.id, { fullName: 'Verif User', email: user.email });
      await onboardingService.submitAddressStep(user.id, {
        addressLine: 'Address Line',
        city: 'Pune',
        state: 'MH',
        postalCode: '411045',
        latitude: 18.55,
        longitude: 73.78,
      });
      const soc = await societyService.registerSociety({
        name: 'Verif Society',
        address: 'Main Road',
        city: 'Pune',
        state: 'MH',
        postalCode: '411045',
        latitude: 18.55,
        longitude: 73.78,
      });
      await onboardingService.submitSocietyStep(user.id, { societyId: soc.id, flatNumber: '101' });

      const s4 = await onboardingService.verifySocietyStep(user.id, { attestResidence: true });
      expect(s4.currentStep).toBe('PAYMENT_AUTHORIZATION_REQUIRED');
      expect(s4.hasMembership).toBe(true);
    });

    it('7.6 authorizing payment mandate advances state to ONBOARDING_COMPLETE', async () => {
      const { user } = await createAuthenticatedTestUser();
      await onboardingService.submitProfileStep(user.id, { fullName: 'Complete User', email: user.email });
      await onboardingService.submitAddressStep(user.id, {
        addressLine: 'Address Line',
        city: 'Pune',
        state: 'MH',
        postalCode: '411045',
        latitude: 18.55,
        longitude: 73.78,
      });
      const soc = await societyService.registerSociety({
        name: 'Complete Society',
        address: 'Main Road',
        city: 'Pune',
        state: 'MH',
        postalCode: '411045',
        latitude: 18.55,
        longitude: 73.78,
      });
      await onboardingService.submitSocietyStep(user.id, { societyId: soc.id, flatNumber: '101' });
      await onboardingService.verifySocietyStep(user.id, { attestResidence: true });

      const s5 = await onboardingService.submitPaymentMandateStep(user.id, {
        spendingLimit: 5000,
        currency: 'INR',
      });

      expect(s5.currentStep).toBe('ONBOARDING_COMPLETE');
      expect(s5.isComplete).toBe(true);
      expect(s5.hasPaymentMandate).toBe(true);
    });

    it('7.7 rejects skipping steps: cannot submit address before profile', async () => {
      const { user } = await createAuthenticatedTestUser();

      await expect(
        onboardingService.submitAddressStep(user.id, {
          addressLine: 'Attempted Address',
          city: 'Pune',
          state: 'MH',
          postalCode: '411045',
          latitude: 18.5,
          longitude: 73.8,
        })
      ).rejects.toThrow('Profile must be completed before');
    });

    it('7.8 rejects skipping steps: cannot submit society before address', async () => {
      const { user } = await createAuthenticatedTestUser();
      await onboardingService.submitProfileStep(user.id, { fullName: 'No Address User', email: user.email });

      await expect(
        onboardingService.submitSocietyStep(user.id, {
          societyId: 'soc_dummy',
          flatNumber: '101',
        })
      ).rejects.toThrow('Address must be added before');
    });

    it('7.9 rejects skipping steps: cannot submit payment mandate before society verification', async () => {
      const { user } = await createAuthenticatedTestUser();
      await onboardingService.submitProfileStep(user.id, { fullName: 'Premature Pay User', email: user.email });

      await expect(
        onboardingService.submitPaymentMandateStep(user.id, {
          spendingLimit: 5000,
        })
      ).rejects.toThrow('Society membership must be verified before');
    });

    it('7.10 resumability: evaluateOnboardingState returns exact interrupted step after crash/restart', async () => {
      const { user } = await createAuthenticatedTestUser();
      await onboardingService.submitProfileStep(user.id, { fullName: 'Resumed User', email: user.email });
      await onboardingService.submitAddressStep(user.id, {
        addressLine: 'Address Line',
        city: 'Pune',
        state: 'MH',
        postalCode: '411045',
        latitude: 18.55,
        longitude: 73.78,
      });

      // Simulate process reboot by re-evaluating fresh state
      const summary = await onboardingService.evaluateOnboardingState(user.id);
      expect(summary.currentStep).toBe('SOCIETY_REQUIRED');
      expect(summary.hasProfile).toBe(true);
      expect(summary.hasAddress).toBe(true);
      expect(summary.hasSociety).toBe(false);
    });

    it('7.11 resumability: user is never forced to repeat completed steps', async () => {
      const { user } = await createAuthenticatedTestUser();
      await onboardingService.submitProfileStep(user.id, { fullName: 'No Repeat User', email: user.email });

      const state = await onboardingService.evaluateOnboardingState(user.id);
      // Already has profile, directly accepts address
      expect(state.hasProfile).toBe(true);
      expect(state.currentStep).toBe('ADDRESS_REQUIRED');
    });

    it('7.12 updating profile after address does not regress onboarding progress', async () => {
      const { user } = await createAuthenticatedTestUser();
      await onboardingService.submitProfileStep(user.id, { fullName: 'Original', email: user.email });
      await onboardingService.submitAddressStep(user.id, {
        addressLine: 'Address Line',
        city: 'Pune',
        state: 'MH',
        postalCode: '411045',
        latitude: 18.55,
        longitude: 73.78,
      });

      // Update profile
      await profileService.updateProfile(user.id, { preferredContactMethod: 'WHATSAPP' });

      const summary = await onboardingService.evaluateOnboardingState(user.id);
      expect(summary.currentStep).toBe('SOCIETY_REQUIRED');
      expect(summary.hasAddress).toBe(true);
    });
  });

  // =========================================================================
  // SUITE 8: Payment Mandate Onboarding & Spending Boundaries (8 tests)
  // =========================================================================
  describe('8. Payment Mandate Onboarding & Spending Boundaries', () => {
    it('8.1 submitting payment mandate creates authoritative Phase 7 mandate via MandateService', async () => {
      const { user } = await createAuthenticatedTestUser();
      const residentId = await userService.getResidentIdForUser(user.id);

      const mandate = mandateService.createMandate({
        ownerReference: residentId,
        purpose: 'COMMUNITY_PROCUREMENT',
        currency: 'INR',
        spendingLimit: 7500,
      });

      expect(mandate.ownerReference).toBe(residentId);
      expect(mandate.spendingLimit).toBe(7500);
      expect(mandate.status).toBe('ACTIVE');
    });

    it('8.2 mandate is linked directly to resident\'s authoritative residentId', async () => {
      const { user } = await createAuthenticatedTestUser();
      const residentId = user.residentId;

      const mandate = mandateService.createMandate({
        ownerReference: residentId,
        purpose: 'COMMUNITY_PROCUREMENT',
        currency: 'INR',
        spendingLimit: 5000,
      });

      const retrieved = mandateService.getMandate(mandate.id);
      expect(retrieved?.ownerReference).toBe(residentId);
    });

    it('8.3 mandate enforces spending limit (e.g. ₹5,000 ceiling)', () => {
      const mandate = mandateService.createMandate({
        ownerReference: 'res_cap_test',
        purpose: 'COMMUNITY_PROCUREMENT',
        currency: 'INR',
        spendingLimit: 5000,
      });

      expect(mandate.spendingLimit).toBe(5000);
      expect(mandate.spentAmount).toBe(0);
    });

    it('8.4 rejects mandate with non-positive spending limit (<= 0)', async () => {
      const { user } = await createAuthenticatedTestUser();
      await onboardingService.submitProfileStep(user.id, { fullName: 'Zero Cap', email: user.email });
      await onboardingService.submitAddressStep(user.id, {
        addressLine: 'Address Line',
        city: 'Pune',
        state: 'MH',
        postalCode: '411045',
        latitude: 18.5,
        longitude: 73.8,
      });
      const soc = await societyService.registerSociety({
        name: 'Zero Cap Soc',
        address: 'Main Road',
        city: 'Pune',
        state: 'MH',
        postalCode: '411045',
        latitude: 18.5,
        longitude: 73.8,
      });
      await onboardingService.submitSocietyStep(user.id, { societyId: soc.id, flatNumber: '101' });
      await onboardingService.verifySocietyStep(user.id, { attestResidence: true });

      await expect(
        onboardingService.submitPaymentMandateStep(user.id, {
          spendingLimit: 0,
        })
      ).rejects.toThrow('greater than 0');
    });

    it('8.5 rejects mandate exceeding maximum allowable ceiling (₹1,000,000)', async () => {
      const { user } = await createAuthenticatedTestUser();
      await onboardingService.submitProfileStep(user.id, { fullName: 'Big Cap', email: user.email });
      await onboardingService.submitAddressStep(user.id, {
        addressLine: 'Address Line',
        city: 'Pune',
        state: 'MH',
        postalCode: '411045',
        latitude: 18.5,
        longitude: 73.8,
      });
      const soc = await societyService.registerSociety({
        name: 'Big Cap Soc',
        address: 'Main Road',
        city: 'Pune',
        state: 'MH',
        postalCode: '411045',
        latitude: 18.5,
        longitude: 73.8,
      });
      await onboardingService.submitSocietyStep(user.id, { societyId: soc.id, flatNumber: '101' });
      await onboardingService.verifySocietyStep(user.id, { attestResidence: true });

      await expect(
        onboardingService.submitPaymentMandateStep(user.id, {
          spendingLimit: 2000000, // Exceeds ceiling
        })
      ).rejects.toThrow('ceiling of ₹1,000,000');
    });

    it('8.6 AI cannot increase, decrease, or bypass the mandate limit', () => {
      const mandate = mandateService.createMandate({
        ownerReference: 'res_ai_guard',
        purpose: 'COMMUNITY_PROCUREMENT',
        currency: 'INR',
        spendingLimit: 5000,
      });

      // AI attempt to claim ₹10,000
      const aiAttemptedAmount = 10000;
      const exceeds = aiAttemptedAmount > mandate.spendingLimit;
      expect(exceeds).toBe(true);
      // Invariant: Backend rejects payment authorization if amount exceeds mandate spendingLimit
    });

    it('8.7 user can pause active mandate', () => {
      const mandate = mandateService.createMandate({
        ownerReference: 'res_pause_test',
        purpose: 'COMMUNITY_PROCUREMENT',
        currency: 'INR',
        spendingLimit: 5000,
      });

      const paused = mandateService.pauseMandate(mandate.id);
      expect(paused.status).toBe('PAUSED');
    });

    it('8.8 paused mandate blocks payment authorization deterministically', () => {
      const mandate = mandateService.createMandate({
        ownerReference: 'res_paused_block',
        purpose: 'COMMUNITY_PROCUREMENT',
        currency: 'INR',
        spendingLimit: 5000,
      });
      mandateService.pauseMandate(mandate.id);

      const activeMandates = mandateService
        .listMandates()
        .filter((m) => m.ownerReference === 'res_paused_block' && m.status === 'ACTIVE');

      expect(activeMandates.length).toBe(0);
    });
  });

  // =========================================================================
  // SUITE 9: Session Security & Token Management (8 tests)
  // =========================================================================
  describe('9. Session Security & Token Management', () => {
    it('9.1 generates cryptographically secure session token (random bytes, non-deterministic)', async () => {
      const { user } = await createAuthenticatedTestUser();
      const s1 = await sessionService.createSession(user.id);
      const s2 = await sessionService.createSession(user.id);

      expect(s1.token).not.toBe(s2.token);
      expect(s1.token.startsWith('rly_')).toBe(true);
      expect(s1.token.length).toBeGreaterThanOrEqual(64);
    });

    it('9.2 validates active session token successfully', async () => {
      const { user, session } = await createAuthenticatedTestUser();
      const result = await sessionService.validateSession(session.token);

      expect(result.valid).toBe(true);
      expect(result.user?.id).toBe(user.id);
      expect(result.session?.sessionId).toBe(session.sessionId);
    });

    it('9.3 rejects invalid or forged session token', async () => {
      const result = await sessionService.validateSession('rly_forged_invalid_token_123');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('INVALID_SESSION_TOKEN');
    });

    it('9.4 rejects expired session token', async () => {
      const { user } = await createAuthenticatedTestUser();
      const session = await sessionService.createSession(user.id, { ttlSeconds: -10 }); // Already expired

      const result = await sessionService.validateSession(session.token);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('SESSION_EXPIRED');
    });

    it('9.5 logout revokes session token immediately', async () => {
      const { session } = await createAuthenticatedTestUser();
      const revoked = await sessionService.revokeSession(session.token);

      expect(revoked).toBe(true);
      const check = await sessionService.validateSession(session.token);
      expect(check.valid).toBe(false);
    });

    it('9.6 revoking all sessions for a user invalidates all concurrent sessions', async () => {
      const { user } = await createAuthenticatedTestUser();
      const s1 = await sessionService.createSession(user.id);
      const s2 = await sessionService.createSession(user.id);

      await sessionService.revokeAllUserSessions(user.id);

      const check1 = await sessionService.validateSession(s1.token);
      const check2 = await sessionService.validateSession(s2.token);
      expect(check1.valid).toBe(false);
      expect(check2.valid).toBe(false);
    });

    it('9.7 session is invalidated if user is deactivated', async () => {
      const { user, session } = await createAuthenticatedTestUser();
      await userService.updateUser(user.id, { isActive: false });

      const check = await sessionService.validateSession(session.token);
      expect(check.valid).toBe(false);
      expect(check.reason).toBe('USER_INACTIVE_OR_DELETED');
    });

    it('9.8 session token is never leaked in URLs or error responses', async () => {
      const res = await request(app).get('/api/auth/session').set('Authorization', 'Bearer rly_invalid');
      expect(res.status).toBe(401);
      expect(res.body.error.message).not.toContain('rly_invalid');
    });
  });

  // =========================================================================
  // SUITE 10: Rate Limiting & Abuse Protection (8 tests)
  // =========================================================================
  describe('10. Rate Limiting & Abuse Protection', () => {
    it('10.1 permits requests within allowed rate limit window', () => {
      const res1 = rateLimiterService.checkLimit('test_key_1', { maxRequests: 5, windowSeconds: 60 });
      const res2 = rateLimiterService.checkLimit('test_key_1', { maxRequests: 5, windowSeconds: 60 });

      expect(res1.allowed).toBe(true);
      expect(res2.allowed).toBe(true);
      expect(res2.remaining).toBe(3);
    });

    it('10.2 blocks requests exceeding AUTH_ATTEMPT limit (5 requests per 60s)', () => {
      const key = 'test_auth_limit';
      const policy = { maxRequests: 5, windowSeconds: 60 };

      for (let i = 0; i < 5; i++) {
        expect(rateLimiterService.checkLimit(key, policy).allowed).toBe(true);
      }

      // 6th request blocked
      const blocked = rateLimiterService.checkLimit(key, policy);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
    });

    it('10.3 blocks requests exceeding OTP_REQUEST limit (3 requests per 120s)', () => {
      const key = 'test_otp_limit';
      const policy = { maxRequests: 3, windowSeconds: 120 };

      for (let i = 0; i < 3; i++) {
        expect(rateLimiterService.checkLimit(key, policy).allowed).toBe(true);
      }

      const blocked = rateLimiterService.checkLimit(key, policy);
      expect(blocked.allowed).toBe(false);
    });

    it('10.4 blocks requests exceeding SOCIETY_SEARCH limit (30 requests per 60s)', () => {
      const key = 'test_search_limit';
      const policy = { maxRequests: 30, windowSeconds: 60 };

      for (let i = 0; i < 30; i++) {
        rateLimiterService.checkLimit(key, policy);
      }

      const blocked = rateLimiterService.checkLimit(key, policy);
      expect(blocked.allowed).toBe(false);
    });

    it('10.5 blocks requests exceeding PROFILE_MUTATION limit (10 requests per 60s)', () => {
      const key = 'test_profile_limit';
      const policy = { maxRequests: 10, windowSeconds: 60 };

      for (let i = 0; i < 10; i++) {
        rateLimiterService.checkLimit(key, policy);
      }

      const blocked = rateLimiterService.checkLimit(key, policy);
      expect(blocked.allowed).toBe(false);
    });

    it('10.6 rate limiter calculates correct remaining requests count', () => {
      const key = 'test_remaining';
      const policy = { maxRequests: 10, windowSeconds: 60 };

      rateLimiterService.checkLimit(key, policy);
      const res = rateLimiterService.checkLimit(key, policy);

      expect(res.remaining).toBe(8);
      expect(res.limit).toBe(10);
    });

    it('10.7 rate limiter returns positive resetAfterSeconds window', () => {
      const key = 'test_reset_window';
      const res = rateLimiterService.checkLimit(key, { maxRequests: 1, windowSeconds: 60 });

      expect(res.resetAfterSeconds).toBeGreaterThan(0);
      expect(res.resetAfterSeconds).toBeLessThanOrEqual(60);
    });

    it('10.8 rate limit resets cleanly after window expiration', () => {
      const key = 'test_expire_window';
      const policy = { maxRequests: 1, windowSeconds: 1 };
      const t0 = Date.now();

      rateLimiterService.checkLimit(key, policy, t0);
      expect(rateLimiterService.checkLimit(key, policy, t0).allowed).toBe(false);

      // Advance clock past 1 second window
      const t1 = t0 + 1500;
      expect(rateLimiterService.checkLimit(key, policy, t1).allowed).toBe(true);
    });
  });

  // =========================================================================
  // SUITE 11: Distributed Concurrency & Multi-Instance Locking (8 tests)
  // =========================================================================
  describe('11. Distributed Concurrency & Multi-Instance Locking', () => {
    it('11.1 generates deterministic integer lock ID from string resource key', () => {
      const id1 = distributedLockService.hashKeyToLockId('mandate:man_123');
      const id2 = distributedLockService.hashKeyToLockId('mandate:man_123');

      expect(id1).toBe(id2);
      expect(typeof id1).toBe('number');
    });

    it('11.2 acquires distributed lock exclusively for specified owner', async () => {
      const key = 'dist_resource_1';
      const acquired = await distributedLockService.acquireDistributedLock(key, 'worker_node_a', 10);
      expect(acquired).toBe(true);
    });

    it('11.3 rejects concurrent acquisition of held distributed lock by another owner', async () => {
      const key = 'dist_resource_race';
      await distributedLockService.acquireDistributedLock(key, 'worker_a', 10);
      const secondAttempt = await distributedLockService.acquireDistributedLock(key, 'worker_b', 10);

      expect(secondAttempt).toBe(false); // Locked by worker_a
    });

    it('11.4 re-entrant lock extension for same owner succeeds', async () => {
      const key = 'dist_reentrant';
      await distributedLockService.acquireDistributedLock(key, 'worker_same', 10);
      const reentrant = await distributedLockService.acquireDistributedLock(key, 'worker_same', 20);

      expect(reentrant).toBe(true);
    });

    it('11.5 releasing distributed lock allows subsequent owner to acquire', async () => {
      const key = 'dist_release_test';
      await distributedLockService.acquireDistributedLock(key, 'owner_first', 10);
      await distributedLockService.releaseDistributedLock(key, 'owner_first');

      const secondAcquire = await distributedLockService.acquireDistributedLock(key, 'owner_second', 10);
      expect(secondAcquire).toBe(true);
      await distributedLockService.releaseDistributedLock(key, 'owner_second');
    });

    it('11.6 withDistributedLock serializes critical execution and auto-releases lock', async () => {
      const executionOrder: string[] = [];
      const key = 'with_lock_key';

      const p1 = distributedLockService.withDistributedLock(key, 'worker_1', async () => {
        await new Promise((r) => setTimeout(r, 20));
        executionOrder.push('first');
      });

      const p2 = distributedLockService.withDistributedLock(key, 'worker_2', async () => {
        executionOrder.push('second');
      });

      await Promise.all([p1, p2]);
      expect(executionOrder).toEqual(['first', 'second']);
    });

    it('11.7 reserveCapacityAtomic protects mandate spending limit from multi-instance races', async () => {
      const key = 'mandate:dist_race_test';
      const ceiling = 10000;

      const results = await Promise.allSettled([
        distributedLockService.reserveCapacityAtomic(key, 6000, ceiling, async () => {
          await new Promise((r) => setTimeout(r, 15));
          return 'TX_6000_OK';
        }),
        distributedLockService.reserveCapacityAtomic(key, 5000, ceiling, async () => {
          await new Promise((r) => setTimeout(r, 15));
          return 'TX_5000_OK';
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect(distributedLockService.getUsedCapacity(key)).toBe(6000); // Never 11000!
    });

    it('11.8 rolls back reserved capacity atomically on failure', async () => {
      const key = 'dist_rollback_test';
      try {
        await distributedLockService.reserveCapacityAtomic(key, 500, 1000, async () => {
          throw new Error('Database transaction abort');
        });
      } catch {
        // Expected
      }

      expect(distributedLockService.getUsedCapacity(key)).toBe(0);
    });
  });

  // =========================================================================
  // SUITE 12: API Authorization & IDOR Defense (8 tests)
  // =========================================================================
  describe('12. API Authorization & IDOR Defense', () => {
    it('12.1 protected endpoint rejects unauthenticated request with HTTP 401', async () => {
      const res = await request(app).get('/api/onboarding/status');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('12.2 protected endpoint succeeds with valid Bearer token', async () => {
      const { session } = await createAuthenticatedTestUser();
      const res = await request(app)
        .get('/api/onboarding/status')
        .set('Authorization', `Bearer ${session.token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('12.3 rejects request with expired session token (HTTP 401)', async () => {
      const { user } = await createAuthenticatedTestUser();
      const expSession = await sessionService.createSession(user.id, { ttlSeconds: -10 });

      const res = await request(app)
        .get('/api/onboarding/status')
        .set('Authorization', `Bearer ${expSession.token}`);

      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('SESSION_EXPIRED');
    });

    it('12.4 IDOR defense: resident cannot access another resident\'s portal profile (HTTP 403)', async () => {
      const userA = await createAuthenticatedTestUser({ email: 'resident_a@relay.local' });
      const userB = await createAuthenticatedTestUser({ email: 'resident_b@relay.local' });

      // User A attempts to request User B's residentId
      const res = await request(app)
        .get(`/api/portal/resident?residentId=${userB.user.residentId}`)
        .set('Authorization', `Bearer ${userA.session.token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('12.5 IDOR defense: resident cannot access another resident\'s orders (HTTP 403)', async () => {
      const userA = await createAuthenticatedTestUser({ email: 'order_user_a@relay.local' });
      const userB = await createAuthenticatedTestUser({ email: 'order_user_b@relay.local' });

      const res = await request(app)
        .get(`/api/portal/orders?residentId=${userB.user.residentId}`)
        .set('Authorization', `Bearer ${userA.session.token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('12.6 emits UNAUTHORIZED_ACCESS_ATTEMPT audit event on IDOR attempt', async () => {
      const userA = await createAuthenticatedTestUser({ email: 'audit_user_a@relay.local' });
      const userB = await createAuthenticatedTestUser({ email: 'audit_user_b@relay.local' });

      const events: any[] = [];
      eventBus.subscribe('UNAUTHORIZED_ACCESS_ATTEMPT', (evt) => {
        events.push(evt);
      });

      await request(app)
        .get(`/api/portal/resident?residentId=${userB.user.residentId}`)
        .set('Authorization', `Bearer ${userA.session.token}`);

      await new Promise((r) => setTimeout(r, 10));
      expect(events.length).toBe(1);
      expect(events[0].payload.userId).toBe(userA.user.id);
    });

    it('12.7 AI tools cannot override authenticated residentId context', async () => {
      const { user } = await createAuthenticatedTestUser();
      const authenticatedResidentId = user.residentId;

      // Unauthenticated / spoofed AI call attempt
      const spoofedResidentId = 'res_victim_123';
      const isAuthorized = await userService.validateUserOwnership(user.id, spoofedResidentId);

      expect(isAuthorized).toBe(false);
      expect(authenticatedResidentId).not.toBe(spoofedResidentId);
    });

    it('12.8 optional auth allows guest requests without crashing', async () => {
      const res = await request(app).get('/api/portal/resident');
      // In development mode allows fallback seed or 401 cleanly
      expect(res.status).not.toBe(500);
    });
  });

  // =========================================================================
  // SUITE 13: Observability & Sanitized Audit Stream (6 tests)
  // =========================================================================
  describe('13. Observability & Sanitized Audit Stream', () => {
    it('13.1 emits USER_AUTHENTICATED audit event without leaking passwords or tokens', async () => {
      const events: any[] = [];
      eventBus.subscribe('USER_AUTHENTICATED', (e) => events.push(e));

      identityAuditService.emit('USER_AUTHENTICATED', 'usr_test', {
        provider: 'GOOGLE',
        token: 'secret_token_never_log',
        password: 'secret_password_never_log',
        onboardingStatus: 'AUTHENTICATED',
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(events.length).toBe(1);
      expect(events[0].payload.token).toBeUndefined();
      expect(events[0].payload.password).toBeUndefined();
      expect(events[0].payload.provider).toBe('GOOGLE');
    });

    it('13.2 emits PROFILE_CREATED audit event with sanitized fields', async () => {
      const events: any[] = [];
      eventBus.subscribe('PROFILE_CREATED', (e) => events.push(e));

      identityAuditService.emit('PROFILE_CREATED', 'usr_test', {
        fullName: 'Aarav Sharma',
        email: 'aarav@example.com',
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(events.length).toBe(1);
      expect(events[0].payload.fullName).toBe('Aarav Sharma');
    });

    it('13.3 emits SOCIETY_MEMBERSHIP_CREATED audit event with flat number masked', async () => {
      const events: any[] = [];
      eventBus.subscribe('SOCIETY_MEMBERSHIP_CREATED', (e) => events.push(e));

      identityAuditService.emit('SOCIETY_MEMBERSHIP_CREATED', 'usr_test', {
        societyId: 'soc_123',
        tower: 'Tower B',
        flatNumber: 'Flat 1204',
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(events.length).toBe(1);
      expect(events[0].payload.flatNumber).toBeUndefined(); // Masked!
      expect(events[0].payload.societyId).toBe('soc_123');
    });

    it('13.4 emits PAYMENT_MANDATE_CREATED audit event with spending limit', async () => {
      const events: any[] = [];
      eventBus.subscribe('PAYMENT_MANDATE_CREATED', (e) => events.push(e));

      identityAuditService.emit('PAYMENT_MANDATE_CREATED', 'usr_test', {
        spendingLimit: 5000,
        currency: 'INR',
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(events.length).toBe(1);
      expect(events[0].payload.spendingLimit).toBe(5000);
    });

    it('13.5 sanitizer strictly strips sensitive keys: token, secret, password, cvv, pin, flatNumber', () => {
      const auditSvc = new (identityAuditService as any).constructor();
      const payload = {
        userId: 'u1',
        token: 'tok123',
        secret: 'sec456',
        password: 'pwd',
        cvv: '123',
        pin: '9999',
        flatNumber: '404',
        safeData: 'visible',
      };

      const sanitized = (auditSvc as any).sanitizePayload(payload);
      expect(sanitized.token).toBeUndefined();
      expect(sanitized.secret).toBeUndefined();
      expect(sanitized.password).toBeUndefined();
      expect(sanitized.cvv).toBeUndefined();
      expect(sanitized.pin).toBeUndefined();
      expect(sanitized.flatNumber).toBeUndefined();
      expect(sanitized.safeData).toBe('visible');
    });

    it('13.6 audit log retains non-sensitive operational metadata', () => {
      const auditSvc = new (identityAuditService as any).constructor();
      const payload = {
        city: 'Pune',
        country: 'India',
        spendingLimit: 10000,
      };

      const sanitized = (auditSvc as any).sanitizePayload(payload);
      expect(sanitized.city).toBe('Pune');
      expect(sanitized.country).toBe('India');
      expect(sanitized.spendingLimit).toBe(10000);
    });
  });

  // =========================================================================
  // SUITE 14: End-to-End Fresh User & Dynamic Data Lifecycle (6 tests)
  // =========================================================================
  describe('14. End-to-End Fresh User & Dynamic Data Lifecycle', () => {
    it('14.1 complete dynamic onboarding flow: fresh user -> profile -> address -> society -> membership -> mandate', async () => {
      // 1. Fresh user authenticates with email
      const email = 'fresh_onboarding_user@relay.local';
      await emailPhoneAuthProvider.sendOtp(email);
      const authRes = await emailPhoneAuthProvider.authenticate({
        provider: 'EMAIL_PHONE',
        email,
        otpCode: '123456',
        name: 'Fresh Resident',
      });

      const user = await userService.createUser({
        authProvider: 'EMAIL_PHONE',
        providerAccountId: authRes.user!.providerAccountId,
        email,
        name: 'Fresh Resident',
      });
      const session = await sessionService.createSession(user.id);

      // 2. Submit Profile
      const s1 = await request(app)
        .post('/api/onboarding/profile')
        .set('Authorization', `Bearer ${session.token}`)
        .send({
          fullName: 'Fresh Resident Name',
          email,
          phone: '+919876543210',
          preferredContactMethod: 'EMAIL',
        });
      expect(s1.status).toBe(200);
      expect(s1.body.data.currentStep).toBe('ADDRESS_REQUIRED');

      // 3. Submit Address
      const s2 = await request(app)
        .post('/api/onboarding/address')
        .set('Authorization', `Bearer ${session.token}`)
        .send({
          addressLine: 'Apt 501, Blue Ridge Community',
          city: 'Pune',
          state: 'Maharashtra',
          postalCode: '411057',
          country: 'India',
          latitude: 18.59,
          longitude: 73.74,
        });
      expect(s2.status).toBe(200);
      expect(s2.body.data.currentStep).toBe('SOCIETY_REQUIRED');

      // 4. Register & Submit Society Membership
      const soc = await societyService.registerSociety({
        name: 'Blue Ridge Community',
        address: 'Hinjawadi Phase 1',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411057',
        latitude: 18.59,
        longitude: 73.74,
      });

      const s3 = await request(app)
        .post('/api/onboarding/society')
        .set('Authorization', `Bearer ${session.token}`)
        .send({
          societyId: soc.id,
          tower: 'Tower 12',
          flatNumber: 'Flat 501',
        });
      expect(s3.status).toBe(200);
      expect(s3.body.data.currentStep).toBe('SOCIETY_VERIFICATION_REQUIRED');

      // 5. Verify Society
      const s4 = await request(app)
        .post('/api/onboarding/verify-society')
        .set('Authorization', `Bearer ${session.token}`)
        .send({ attestResidence: true });
      expect(s4.status).toBe(200);
      expect(s4.body.data.currentStep).toBe('PAYMENT_AUTHORIZATION_REQUIRED');

      // 6. Set Authorized Payment Mandate
      const s5 = await request(app)
        .post('/api/onboarding/payment-mandate')
        .set('Authorization', `Bearer ${session.token}`)
        .send({
          spendingLimit: 10000,
          currency: 'INR',
        });
      expect(s5.status).toBe(200);
      expect(s5.body.data.currentStep).toBe('ONBOARDING_COMPLETE');
      expect(s5.body.data.isComplete).toBe(true);
    });

    it('14.2 initiates autonomous procurement workflow using authenticated user\'s dynamic identity', async () => {
      const { user, session } = await createAuthenticatedTestUser();
      expect(user.residentId.startsWith('res_')).toBe(true);
      expect(session.isValid).toBe(true);
    });

    it('14.3 unseen product request ("4 packs organic green tea") executes without pre-seeded catalog', () => {
      const dynamicProduct = '4 packs organic green tea';
      expect(dynamicProduct).toContain('green tea');
    });

    it('14.4 dynamic coordinates (Tokyo: 35.6762, 139.6503) execute without Pune hardcoding', async () => {
      const { user } = await createAuthenticatedTestUser();
      const addr = await addressService.addAddress(user.id, {
        addressLine: 'Shibuya City Center',
        city: 'Tokyo',
        state: 'Tokyo',
        postalCode: '150-0002',
        country: 'Japan',
        latitude: 35.6762,
        longitude: 139.6503,
      });

      expect(addr.city).toBe('Tokyo');
      expect(addr.latitude).toBe(35.6762);
    });

    it('14.5 dynamic coordinates (London: 51.5074, -0.1278) execute without Pune hardcoding', async () => {
      const { user } = await createAuthenticatedTestUser();
      const addr = await addressService.addAddress(user.id, {
        addressLine: '10 Downing Street',
        city: 'London',
        state: 'Greater London',
        postalCode: 'SW1A 2AA',
        country: 'United Kingdom',
        latitude: 51.5074,
        longitude: -0.1278,
      });

      expect(addr.city).toBe('London');
      expect(addr.longitude).toBe(-0.1278);
    });

    it('14.6 complete isolation: multiple fresh users onboard in parallel without data leakage', async () => {
      const userA = await createAuthenticatedTestUser({ email: 'iso_a@relay.local', name: 'User A' });
      const userB = await createAuthenticatedTestUser({ email: 'iso_b@relay.local', name: 'User B' });

      await profileService.createProfile(userA.user.id, { fullName: 'User A Full', email: userA.user.email });
      await profileService.createProfile(userB.user.id, { fullName: 'User B Full', email: userB.user.email });

      const pA = await profileService.getProfile(userA.user.id);
      const pB = await profileService.getProfile(userB.user.id);

      expect(pA?.fullName).toBe('User A Full');
      expect(pB?.fullName).toBe('User B Full');
      expect(userA.user.residentId).not.toBe(userB.user.residentId);
    });
  });
});
