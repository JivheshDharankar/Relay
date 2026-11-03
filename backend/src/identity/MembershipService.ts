import { randomUUID } from 'crypto';
import {
  MembershipVerificationStatus,
  SocietyMembership,
  SupplierCommunityDeliveryView,
} from './types';
import { CreateMembershipInputSchema } from './validation';
import { societyService, SocietyService } from './SocietyService';
import { userService, UserService } from './UserService';
import { AppError } from '../domain/errors';

export class MembershipService {
  private membershipsById = new Map<string, SocietyMembership>();
  private membershipsByUser = new Map<string, string>(); // userId -> membershipId
  private membershipsBySociety = new Map<string, Set<string>>(); // societyId -> Set<membershipId>

  constructor(
    private readonly societySvc: SocietyService = societyService,
    private readonly userSvc: UserService = userService
  ) {}

  public async getMembershipByUserId(userId: string): Promise<SocietyMembership | undefined> {
    const membershipId = this.membershipsByUser.get(userId);
    if (!membershipId) return undefined;
    return this.membershipsById.get(membershipId);
  }

  public async getMembershipById(id: string): Promise<SocietyMembership | undefined> {
    return this.membershipsById.get(id);
  }

  /**
   * Server-side only restoration of a membership for a returning user whose
   * residency is already proven by a durable PostgreSQL resident row.
   * Memberships are in-memory only (no database table), so a fresh id is
   * minted while the society link and VERIFIED status are preserved.
   * Idempotent per user: an existing membership is returned untouched.
   * Never accepts client input.
   */
  public async restoreMembership(input: {
    userId: string;
    societyId: string;
    tower?: string;
    flatNumber: string;
  }): Promise<SocietyMembership> {
    const existingId = this.membershipsByUser.get(input.userId);
    if (existingId) {
      const existing = this.membershipsById.get(existingId);
      if (existing) return existing;
    }
    const user = await this.userSvc.getUserById(input.userId);
    if (!user) {
      throw new Error(`Cannot restore membership: User '${input.userId}' does not exist`);
    }
    const society = await this.societySvc.getSocietyById(input.societyId);
    if (!society) {
      throw new Error(`Society '${input.societyId}' does not exist`);
    }
    const membershipId = `mem_${randomUUID().slice(0, 10)}`;
    const now = new Date();
    const membership: SocietyMembership = {
      id: membershipId,
      userId: input.userId,
      societyId: input.societyId,
      tower: input.tower,
      flatNumber: input.flatNumber,
      verificationStatus: 'VERIFIED',
      verificationMethod: 'DOCUMENT_PROOF',
      createdAt: now,
      updatedAt: now,
    };
    this.membershipsById.set(membershipId, membership);
    this.membershipsByUser.set(input.userId, membershipId);
    const societySet = this.membershipsBySociety.get(input.societyId) || new Set<string>();
    societySet.add(membershipId);
    this.membershipsBySociety.set(input.societyId, societySet);
    return membership;
  }

  /**
   * Creates or updates a resident's society membership.
   */
  public async createMembership(
    userId: string,
    rawInput: unknown
  ): Promise<SocietyMembership> {
    const user = await this.userSvc.getUserById(userId);
    if (!user) {
      throw new Error(`Cannot create membership: User '${userId}' does not exist`);
    }

    const validated = CreateMembershipInputSchema.parse(rawInput);
    const society = await this.societySvc.getSocietyById(validated.societyId);
    if (!society) {
      throw new Error(`Society '${validated.societyId}' does not exist`);
    }

    // Check duplicate membership
    const existingMembershipId = this.membershipsByUser.get(userId);
    if (existingMembershipId) {
      const existing = this.membershipsById.get(existingMembershipId);
      if (existing && existing.societyId === validated.societyId) {
        // Update tower/flat if already in this society
        existing.tower = validated.tower;
        existing.flatNumber = validated.flatNumber;
        existing.updatedAt = new Date();
        return existing;
      }
    }

    const membershipId = `mem_${randomUUID().slice(0, 10)}`;
    const now = new Date();

    // New memberships are always PENDING_VERIFICATION. A client-selected
    // verificationMethod is recorded as the claimed method only — it never
    // confers VERIFIED status by itself. Verification happens exclusively via
    // the explicit attestation step (verifySocietyStep).
    const membership: SocietyMembership = {
      id: membershipId,
      userId,
      societyId: validated.societyId,
      tower: validated.tower,
      flatNumber: validated.flatNumber,
      verificationStatus: 'PENDING_VERIFICATION',
      verificationMethod: validated.verificationMethod,
      createdAt: now,
      updatedAt: now,
    };

    this.membershipsById.set(membershipId, membership);
    this.membershipsByUser.set(userId, membershipId);

    const societySet = this.membershipsBySociety.get(validated.societyId) || new Set<string>();
    societySet.add(membershipId);
    this.membershipsBySociety.set(validated.societyId, societySet);

    return membership;
  }

  public async updateVerificationStatus(
    membershipId: string,
    status: MembershipVerificationStatus,
    notes?: string
  ): Promise<SocietyMembership> {
    const membership = this.membershipsById.get(membershipId);
    if (!membership) {
      throw new Error(`Society membership '${membershipId}' not found`);
    }

    membership.verificationStatus = status;
    if (notes) membership.notes = notes;
    membership.updatedAt = new Date();

    return membership;
  }

  /**
   * CRITICAL PRIVACY BOUNDARY:
   * Provides supplier-facing community delivery location.
   * Guarantees that flat numbers, tower identifiers, resident names,
   * resident emails, and phone numbers NEVER leak to suppliers!
   */
  public async getSupplierCommunityDeliveryView(
    societyId: string
  ): Promise<SupplierCommunityDeliveryView> {
    const society = await this.societySvc.getSocietyById(societyId);
    if (!society) {
      throw new AppError(`Society '${societyId}' not found`, 404, 'SOCIETY_NOT_FOUND');
    }

    return {
      societyId: society.id,
      societyName: society.name,
      communityDeliveryAddress: `${society.name}, ${society.address}`,
      city: society.city,
      state: society.state,
      postalCode: society.postalCode,
      country: society.country,
      latitude: society.latitude,
      longitude: society.longitude,
    };
  }

  public clear(): void {
    this.membershipsById.clear();
    this.membershipsByUser.clear();
    this.membershipsBySociety.clear();
  }
}

export const membershipService = new MembershipService();

