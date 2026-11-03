import { prisma } from '../config/prisma';
import { PaymentMandateStatus } from '@prisma/client';
import { userService, UserService, CreateUserInput } from './UserService';
import { profileService, ProfileService } from './ProfileService';
import { addressService, AddressService } from './AddressService';
import { societyService, SocietyService } from './SocietyService';
import { membershipService, MembershipService } from './MembershipService';
import { mandateService, MandateService } from '../payment/mandate/MandateService';
import { PaymentPurpose } from '../payment/mandate/types';
import { identityAuditService, IdentityAuditService } from './IdentityAuditService';
import { UserIdentity } from './types';

/**
 * Returning-user resolution at the login boundary.
 *
 * Root cause it fixes: session/onboarding identity lives in in-memory
 * registries while PostgreSQL holds the durable procurement rows. After any
 * backend restart the registries are empty, so a returning user missed the
 * in-memory lookup, was minted a brand-new userId/residentId, and died at
 * procurement with RESIDENT_EMAIL_CONFLICT against their own durable row.
 *
 * This service makes login idempotent: when the provider-verified identity
 * already owns a durable resident row, the in-memory registries are rebuilt
 * with the SAME canonical ids (resident, society, mandate) instead of
 * minting fresh ones. Only genuinely new identities enter creation.
 *
 * Security properties:
 * - Resolution keys are provider-verified email/phone only (server-side from
 *   the authenticated provider result). Client-supplied ids/emails are never
 *   trusted and are not even accepted as input.
 * - Proving ownership of the verified email/phone IS the legitimacy check:
 *   OTP is delivered to the address itself and Google verifies its emails,
 *   so a different person cannot resolve someone else's row.
 * - Database uniqueness constraints are untouched; the
 *   RESIDENT_EMAIL_CONFLICT backstop in ProcurementIdentityService stays as
 *   the final guard, as does the same-process
 *   ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER check in UserService.
 * - Concurrent logins for the same provider identity are serialized by a
 *   per-provider-key mutex, so duplicates are impossible. (Single-backend
 *   deployment; a multi-instance rollout would additionally use the
 *   PostgreSQL advisory-lock path in DistributedLockService.)
 */
export class IdentityRehydrationService {
  private readonly pending = new Map<string, Promise<{ user: UserIdentity; isNewUser: boolean }>>();

  constructor(
    private readonly userSvc: UserService = userService,
    private readonly profileSvc: ProfileService = profileService,
    private readonly addressSvc: AddressService = addressService,
    private readonly societySvc: SocietyService = societyService,
    private readonly membershipSvc: MembershipService = membershipService,
    private readonly mandateSvc: MandateService = mandateService,
    private readonly auditSvc: IdentityAuditService = identityAuditService
  ) {}

  public async resolveUser(providerUser: UserIdentity): Promise<{ user: UserIdentity; isNewUser: boolean }> {
    const fastPath = await this.userSvc.findByProvider(
      providerUser.authProvider,
      providerUser.providerAccountId
    );
    if (fastPath) return { user: fastPath, isNewUser: false };

    const key = `${providerUser.authProvider}:${providerUser.providerAccountId}`;
    const prev = this.pending.get(key) ?? Promise.resolve(null as unknown as { user: UserIdentity; isNewUser: boolean });
    const next = prev.then(
      () => this.doResolve(providerUser),
      () => this.doResolve(providerUser)
    );
    this.pending.set(key, next);
    const release = () => {
      if (this.pending.get(key) === next) this.pending.delete(key);
    };
    next.then(release, release);
    return next;
  }

  private async doResolve(providerUser: UserIdentity): Promise<{ user: UserIdentity; isNewUser: boolean }> {
    // Double-checked after acquiring the mutex: a concurrent login may have
    // already resolved or created this identity.
    const raced = await this.userSvc.findByProvider(
      providerUser.authProvider,
      providerUser.providerAccountId
    );
    if (raced) return { user: raced, isNewUser: false };

    const email = providerUser.email.trim().toLowerCase();
    const durable = await this.findDurableResident(email, providerUser.phone);
    if (!durable) {
      const user = await this.userSvc.createUser(this.toCreateInput(providerUser));
      return { user, isNewUser: true };
    }

    const society = await prisma.society.findUnique({ where: { id: durable.societyId } });
    if (!society) {
      // Corrupt durable state (FK should prevent this): preserve legacy
      // behavior rather than inventing a society.
      const user = await this.userSvc.createUser(this.toCreateInput(providerUser));
      return { user, isNewUser: true };
    }

    // Pin identity first: the canonical residentId guarantees procurement
    // resolves the same row and can never hit RESIDENT_EMAIL_CONFLICT.
    const user = await this.userSvc.restoreUser({
      ...this.toCreateInput(providerUser),
      residentId: durable.id,
    });
    await this.societySvc.restoreSociety({
      id: society.id,
      name: society.name,
      address: society.address,
      city: society.city,
      state: society.state,
      postalCode: society.postalCode,
      country: 'India',
      latitude: society.latitude !== null ? Number(society.latitude) : 0,
      longitude: society.longitude !== null ? Number(society.longitude) : 0,
    });

    // Best-effort restoration of the remaining registries. Anything that
    // cannot be restored simply routes the user to that onboarding step to
    // complete it; identity itself is already pinned above.
    const flat = this.splitFlatNumber(durable.flatNumber);
    await this.tryRestore(() =>
      this.membershipSvc.restoreMembership({
        userId: user.id,
        societyId: society.id,
        tower: flat.tower,
        flatNumber: flat.flat,
      })
    );
    await this.tryRestore(() =>
      this.profileSvc.createProfile(user.id, {
        fullName: this.safeFullName(durable.name, providerUser.name),
        email,
        phone: durable.phone ?? undefined,
        preferredContactMethod: 'EMAIL',
        city: society.city,
        state: society.state,
        postalCode: society.postalCode,
      })
    );
    await this.tryRestore(() =>
      this.addressSvc.addAddress(user.id, {
        addressLine: society.address,
        city: society.city,
        state: society.state,
        postalCode: society.postalCode,
        country: 'India',
        latitude: society.latitude !== null ? Number(society.latitude) : 0,
        longitude: society.longitude !== null ? Number(society.longitude) : 0,
        isDefault: true,
      })
    );
    await this.restoreMandate(durable.id);

    this.auditSvc.emit('USER_REHYDRATED', user.id, {
      provider: user.authProvider,
      residentId: user.residentId,
    });
    return { user, isNewUser: false };
  }

  private async restoreMandate(residentId: string): Promise<void> {
    try {
      const row = await prisma.paymentMandate.findFirst({
        where: { residentId },
        orderBy: { createdAt: 'desc' },
      });
      if (!row) return;
      if (this.mandateSvc.getMandate(row.id)) return;
      const mandate = this.mandateSvc.createMandate({
        id: row.id,
        ownerReference: residentId,
        purpose: row.purpose as PaymentPurpose,
        currency: row.currency,
        spendingLimit: Number(row.maximumAmount),
        validFrom: row.periodStart,
        validUntil: row.periodEnd ?? undefined,
        providerReference: row.providerReference ?? undefined,
        metadata: { restoredFrom: 'POSTGRESQL' },
      });
      // Restore durable status: revoked/paused mandates must stay that way.
      // Unknown statuses fail closed to PAUSED (blocks spending).
      if (row.status === PaymentMandateStatus.PAUSED) {
        this.mandateSvc.pauseMandate(mandate.id);
      } else if (row.status === PaymentMandateStatus.REVOKED) {
        this.mandateSvc.revokeMandate(mandate.id);
      } else if (row.status !== PaymentMandateStatus.ACTIVE) {
        this.mandateSvc.pauseMandate(mandate.id);
      }
      // Rebuild spent capacity from settled charges so the spending limit
      // stays enforced across restarts.
      const spent = await prisma.payment.aggregate({
        _sum: { amount: true },
        where: { paymentMandateId: row.id, status: 'SUCCESS' },
      });
      const settled = spent._sum.amount !== null ? Number(spent._sum.amount) : 0;
      if (settled > 0) this.mandateSvc.commitSpending(mandate.id, settled);
    } catch {
      // Missing mandate degrades to the payment-authorization onboarding
      // step; identity itself stays pinned.
    }
  }

  /**
   * Whether provider-verified identity already owns a durable resident row.
   * Lets session validation choose full returning-user rehydration (durable
   * row exists) versus exact identity restore (pre-onboarding session).
   */
  public async hasDurableResident(email: string, phone?: string): Promise<boolean> {
    return (await this.findDurableResident(email.trim().toLowerCase(), phone)) !== null;
  }

  private async findDurableResident(
    email: string,
    phone?: string
  ): Promise<{ id: string; societyId: string; name: string; phone: string | null; flatNumber: string | null } | null> {
    const byEmail = await prisma.resident.findUnique({
      where: { email },
      select: { id: true, societyId: true, name: true, phone: true, flatNumber: true },
    });
    if (byEmail) return byEmail;
    // Phone-authenticated users carry a synthetic provider email; fall back
    // to the verified phone number, resolving only on an unambiguous match.
    if (phone && email.endsWith('@phone.relay.local')) {
      const matches = await prisma.resident.findMany({
        where: { phone },
        select: { id: true, societyId: true, name: true, phone: true, flatNumber: true },
        take: 2,
      });
      if (matches.length === 1) return matches[0];
    }
    return null;
  }

  private toCreateInput(providerUser: UserIdentity): CreateUserInput {
    return {
      authProvider: providerUser.authProvider,
      providerAccountId: providerUser.providerAccountId,
      email: providerUser.email,
      phone: providerUser.phone,
      name: providerUser.name,
      profileImage: providerUser.profileImage,
    };
  }

  /** ProcurementIdentityService stores `${tower}-${flat}`; split on the first dash. */
  private splitFlatNumber(stored: string | null): { tower?: string; flat: string } {
    if (!stored) return { flat: '' };
    const dash = stored.indexOf('-');
    if (dash <= 0) return { flat: stored };
    return { tower: stored.slice(0, dash), flat: stored.slice(dash + 1) };
  }

  private safeFullName(stored: string, providerName: string): string {
    if (stored && stored.trim().length >= 2) return stored.trim();
    if (providerName && providerName.trim().length >= 2) return providerName.trim();
    return 'Resident';
  }

  private async tryRestore(step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch {
      // Gaps degrade to the corresponding onboarding step; see doResolve.
    }
  }
}

export const identityRehydrationService = new IdentityRehydrationService();
