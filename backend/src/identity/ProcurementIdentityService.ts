import { prisma } from '../config/prisma';
import { AppError } from '../domain/errors';
import { PaymentMandateStatus, ResidentStatus } from '@prisma/client';
import { userService, UserService } from './UserService';
import { profileService, ProfileService } from './ProfileService';
import { societyService, SocietyService } from './SocietyService';
import { membershipService, MembershipService } from './MembershipService';
import { mandateService, MandateService } from '../payment/mandate/MandateService';

/**
 * Canonical procurement identities for one authenticated session.
 * The SAME id strings exist in the session, the in-memory registries, and
 * PostgreSQL — one identity, no mapping tables.
 */
export interface CanonicalProcurementIdentities {
  residentId: string;
  societyId: string;
}

/**
 * Bridges Phase 12.5 session/onboarding identity (in-memory registries holding
 * `soc_*` / `res_*` / `mandate_*` ids) with the Phase 1-11 procurement engine
 * (which resolves exclusively via Prisma/PostgreSQL).
 *
 * Called at the agent HTTP boundary for authenticated callers only, immediately
 * before the agent loop. Everything is derived server-side from the session and
 * the registries — frontend-supplied ids are never trusted here (the controller
 * enforces IDOR on those separately). Enforcement stays in the existing tools:
 * missing mandates still yield NO_ACTIVE_MANDATE, overspend still rejected.
 *
 * Unauthenticated (seed/dev) callers never reach this code, so their behavior
 * is byte-for-byte unchanged.
 */
export class ProcurementIdentityService {
  constructor(
    private readonly userSvc: UserService = userService,
    private readonly profileSvc: ProfileService = profileService,
    private readonly societySvc: SocietyService = societyService,
    private readonly membershipSvc: MembershipService = membershipService,
    private readonly mandateSvc: MandateService = mandateService
  ) {}

  public async ensureCanonicalIdentities(userId: string): Promise<CanonicalProcurementIdentities> {
    const user = await this.userSvc.getUserById(userId);
    if (!user) {
      throw new AppError(`User '${userId}' not found`, 401, 'UNAUTHORIZED');
    }
    const residentId = user.residentId;

    const membership = await this.membershipSvc.getMembershipByUserId(userId);
    if (!membership) {
      throw new AppError(
        'Onboarding incomplete: society membership is required before procurement.',
        422,
        'ONBOARDING_INCOMPLETE'
      );
    }

    const society = await this.societySvc.getSocietyById(membership.societyId);
    if (!society) {
      throw new AppError(
        `Society '${membership.societyId}' is not registered.`,
        422,
        'SOCIETY_NOT_REGISTERED'
      );
    }

    // 1. Canonical society row — same soc_* id, registry values verbatim.
    await prisma.society.upsert({
      where: { id: society.id },
      update: {
        name: society.name,
        address: society.address,
        city: society.city,
        state: society.state,
        postalCode: society.postalCode,
        latitude: society.latitude,
        longitude: society.longitude,
      },
      create: {
        id: society.id,
        name: society.name,
        address: society.address,
        city: society.city,
        state: society.state,
        postalCode: society.postalCode,
        latitude: society.latitude,
        longitude: society.longitude,
      },
    });

    // 2. Canonical resident row — same res_* id. Email is globally unique in
    // Prisma, so a verified email owned by a DIFFERENT resident is a controlled
    // conflict, never a silent merge or overwrite.
    const profile = await this.profileSvc.getProfile(userId);
    const email = (profile?.email || user.email || '').trim().toLowerCase();
    if (!email) {
      throw new AppError('Onboarding incomplete: resident email is required.', 422, 'ONBOARDING_INCOMPLETE');
    }
    const emailOwner = await prisma.resident.findUnique({
      where: { email },
      select: { id: true },
    });
    if (emailOwner && emailOwner.id !== residentId) {
      throw new AppError(
        'This email is already registered to another resident.',
        409,
        'RESIDENT_EMAIL_CONFLICT'
      );
    }
    const flatNumber = membership.tower
      ? `${membership.tower}-${membership.flatNumber}`
      : membership.flatNumber;
    await prisma.resident.upsert({
      where: { id: residentId },
      update: {
        societyId: society.id,
        name: profile?.fullName || user.name || 'Resident',
        email,
        phone: profile?.phone ?? user.phone ?? null,
        flatNumber,
        status: ResidentStatus.ACTIVE,
      },
      create: {
        id: residentId,
        societyId: society.id,
        name: profile?.fullName || user.name || 'Resident',
        email,
        phone: profile?.phone ?? user.phone ?? null,
        flatNumber,
        status: ResidentStatus.ACTIVE,
      },
    });

    // 3. Canonical mandate row — same mandate_* id, mirrored only while an
    // ACTIVE in-memory mandate exists. No mandate here means the existing
    // checkAuthorization tool honestly reports NO_ACTIVE_MANDATE.
    const activeMandate = this.mandateSvc
      .listMandates()
      .find(
        (m) =>
          (m.ownerReference === residentId || m.ownerReference === user.id) &&
          m.status === 'ACTIVE'
      );
    if (activeMandate) {
      await prisma.paymentMandate.upsert({
        where: { id: activeMandate.id },
        update: {
          residentId,
          status: PaymentMandateStatus.ACTIVE,
          maximumAmount: activeMandate.spendingLimit,
          currency: activeMandate.currency,
          purpose: activeMandate.purpose,
          periodStart: activeMandate.validFrom,
          periodEnd: activeMandate.validUntil ?? null,
          providerReference: activeMandate.providerReference ?? null,
        },
        create: {
          id: activeMandate.id,
          residentId,
          status: PaymentMandateStatus.ACTIVE,
          maximumAmount: activeMandate.spendingLimit,
          currency: activeMandate.currency,
          purpose: activeMandate.purpose,
          periodStart: activeMandate.validFrom,
          periodEnd: activeMandate.validUntil ?? null,
          providerReference: activeMandate.providerReference ?? null,
        },
      });
    }

    return { residentId, societyId: society.id };
  }
}

export const procurementIdentityService = new ProcurementIdentityService();
