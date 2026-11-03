import { createHash, randomUUID } from 'crypto';
import { AuthProviderType, UserIdentity } from './types';

export interface CreateUserInput {
  authProvider: AuthProviderType;
  providerAccountId: string;
  email: string;
  phone?: string;
  name: string;
  profileImage?: string;
}

export class UserService {
  private usersById = new Map<string, UserIdentity>();
  private usersByProviderAccount = new Map<string, string>(); // `${provider}:${accountId}` -> userId
  private usersByEmail = new Map<string, string>(); // email -> userId
  private residentToUserMap = new Map<string, string>(); // residentId -> userId
  private userToResidentMap = new Map<string, string>(); // userId -> residentId

  /**
   * Derives a stable, deterministic, collision-resistant residentReference for a user.
   * Invariant: A user can NEVER manipulate this reference to gain access to another resident's data.
   */
  public deriveResidentId(userId: string): string {
    const hash = createHash('sha256').update(userId).digest('hex').slice(0, 16);
    return `res_${hash}`;
  }

  /**
   * Creates or registers a new UserIdentity.
   */
  public async createUser(input: CreateUserInput): Promise<UserIdentity> {
    const providerKey = `${input.authProvider}:${input.providerAccountId}`;
    const normalizedEmail = input.email.trim().toLowerCase();

    // Check duplicate provider account
    if (this.usersByProviderAccount.has(providerKey)) {
      const existingId = this.usersByProviderAccount.get(providerKey)!;
      return this.usersById.get(existingId)!;
    }

    // Safety guard: Reject silent merging if an account with this email already exists under another provider
    if (this.usersByEmail.has(normalizedEmail)) {
      const existingUserId = this.usersByEmail.get(normalizedEmail)!;
      const existingUser = this.usersById.get(existingUserId);
      if (existingUser && (existingUser.authProvider !== input.authProvider || existingUser.providerAccountId !== input.providerAccountId)) {
        const error: any = new Error(
          `ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER: An account with email '${normalizedEmail}' already exists using ${existingUser.authProvider}. Please sign in with your original provider.`
        );
        error.code = 'ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER';
        throw error;
      }
    }

    const userId = `usr_${randomUUID().slice(0, 12)}`;
    const residentId = this.deriveResidentId(userId);
    const now = new Date();

    const user: UserIdentity = {
      id: userId,
      authProvider: input.authProvider,
      providerAccountId: input.providerAccountId,
      email: normalizedEmail,
      phone: input.phone,
      name: input.name.trim(),
      profileImage: input.profileImage,
      onboardingStatus: 'AUTHENTICATED',
      residentId,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    this.usersById.set(userId, user);
    this.usersByProviderAccount.set(providerKey, userId);
    this.usersByEmail.set(normalizedEmail, userId);
    this.residentToUserMap.set(residentId, userId);
    this.userToResidentMap.set(userId, residentId);

    return user;
  }

  /**
   * Server-side only restoration of a returning user whose durable identity
   * already exists in PostgreSQL (e.g. after a backend restart wiped the
   * in-memory registries). Pins the canonical residentId from the database
   * row instead of deriving a fresh one, so procurement resolves the SAME
   * resident instead of hitting RESIDENT_EMAIL_CONFLICT.
   *
   * The session-scoped userId is always freshly minted; only the durable
   * residentId is pinned. Never accepts client input — callers must pass
   * provider-verified identity plus the authoritative database row.
   * Idempotent on the provider key: a raced duplicate returns existing.
   */
  public async restoreUser(input: CreateUserInput & { residentId: string }): Promise<UserIdentity> {
    const providerKey = `${input.authProvider}:${input.providerAccountId}`;
    const existingId = this.usersByProviderAccount.get(providerKey);
    if (existingId) {
      const existing = this.usersById.get(existingId);
      if (existing) return existing;
    }
    const normalizedEmail = input.email.trim().toLowerCase();
    const userId = `usr_${randomUUID().slice(0, 12)}`;
    const now = new Date();
    const user: UserIdentity = {
      id: userId,
      authProvider: input.authProvider,
      providerAccountId: input.providerAccountId,
      email: normalizedEmail,
      phone: input.phone,
      name: input.name.trim(),
      profileImage: input.profileImage,
      onboardingStatus: 'AUTHENTICATED',
      residentId: input.residentId,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    this.usersById.set(userId, user);
    this.usersByProviderAccount.set(providerKey, userId);
    this.usersByEmail.set(normalizedEmail, userId);
    this.residentToUserMap.set(input.residentId, userId);
    this.userToResidentMap.set(userId, input.residentId);
    return user;
  }

  /**
   * Server-side only restoration of the EXACT user identity referenced by a
   * durable session row after a backend restart wiped the in-memory
   * registries. Unlike restoreUser (login path, fresh session-scoped id),
   * this preserves the original userId/residentId because nothing durable
   * was ever minted under a different id for this session.
   *
   * Idempotent: if the provider identity already resolved to a live user
   * (e.g. the user logged in again after the restart), the live user wins
   * and no duplicate is created. Never accepts client input — callers must
   * pass the server-trusted session row snapshot.
   */
  public async restoreSessionUser(snapshot: UserIdentity): Promise<UserIdentity> {
    const providerKey = `${snapshot.authProvider}:${snapshot.providerAccountId}`;
    const liveId =
      this.usersByProviderAccount.get(providerKey) ??
      (this.usersById.has(snapshot.id) ? snapshot.id : undefined);
    if (liveId) {
      const live = this.usersById.get(liveId);
      if (live) return live;
    }
    const user: UserIdentity = { ...snapshot };
    this.usersById.set(user.id, user);
    this.usersByProviderAccount.set(providerKey, user.id);
    this.usersByEmail.set(user.email.trim().toLowerCase(), user.id);
    this.residentToUserMap.set(user.residentId, user.id);
    this.userToResidentMap.set(user.id, user.residentId);
    return user;
  }

  public async findByProvider(
    provider: AuthProviderType,
    providerAccountId: string
  ): Promise<UserIdentity | undefined> {
    const providerKey = `${provider}:${providerAccountId}`;
    const userId = this.usersByProviderAccount.get(providerKey);
    if (!userId) return undefined;
    return this.usersById.get(userId);
  }

  public async findByEmail(email: string): Promise<UserIdentity | undefined> {
    const userId = this.usersByEmail.get(email.trim().toLowerCase());
    if (!userId) return undefined;
    return this.usersById.get(userId);
  }

  public async getUserById(userId: string): Promise<UserIdentity | undefined> {
    return this.usersById.get(userId);
  }

  public async getResidentIdForUser(userId: string): Promise<string> {
    const residentId = this.userToResidentMap.get(userId);
    if (residentId) return residentId;
    return this.deriveResidentId(userId);
  }

  public async getUserForResidentId(residentId: string): Promise<UserIdentity | undefined> {
    const userId = this.residentToUserMap.get(residentId);
    if (!userId) return undefined;
    return this.usersById.get(userId);
  }

  /**
   * Authoritatively verifies whether an authenticated user owns a requested resident resource.
   * Crucial IDOR & tenant isolation defense.
   */
  public async validateUserOwnership(
    authenticatedUserId: string,
    requestedResidentId: string
  ): Promise<boolean> {
    const expectedResidentId = await this.getResidentIdForUser(authenticatedUserId);
    return expectedResidentId === requestedResidentId;
  }

  public async updateUser(
    userId: string,
    updates: Partial<Omit<UserIdentity, 'id' | 'residentId' | 'createdAt'>>
  ): Promise<UserIdentity> {
    const user = this.usersById.get(userId);
    if (!user) {
      throw new Error(`User '${userId}' not found`);
    }

    const updated: UserIdentity = {
      ...user,
      ...updates,
      updatedAt: new Date(),
    };

    this.usersById.set(userId, updated);
    return updated;
  }

  public async deactivateUser(userId: string): Promise<UserIdentity> {
    return this.updateUser(userId, { isActive: false });
  }

  public clear(): void {
    this.usersById.clear();
    this.usersByProviderAccount.clear();
    this.usersByEmail.clear();
    this.residentToUserMap.clear();
    this.userToResidentMap.clear();
  }
}

export const userService = new UserService();

