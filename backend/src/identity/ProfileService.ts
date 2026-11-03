import { UserProfile } from './types';
import { CreateProfileInputSchema, UpdateProfileInputSchema } from './validation';
import { userService, UserService } from './UserService';

export class ProfileService {
  private profiles = new Map<string, UserProfile>(); // userId -> UserProfile

  constructor(private readonly userSvc: UserService = userService) {}

  public async getProfile(userId: string): Promise<UserProfile | undefined> {
    return this.profiles.get(userId);
  }

  public async createProfile(
    userId: string,
    rawInput: unknown
  ): Promise<UserProfile> {
    const user = await this.userSvc.getUserById(userId);
    if (!user) {
      throw new Error(`Cannot create profile: User '${userId}' does not exist`);
    }

    // Server-side Zod validation
    const validated = CreateProfileInputSchema.parse(rawInput);
    const now = new Date();

    const profile: UserProfile = {
      userId,
      fullName: validated.fullName,
      email: validated.email,
      phone: validated.phone,
      profilePhoto: validated.profilePhoto,
      preferredContactMethod: validated.preferredContactMethod,
      city: validated.city,
      state: validated.state,
      postalCode: validated.postalCode,
      latitude: validated.latitude,
      longitude: validated.longitude,
      createdAt: now,
      updatedAt: now,
    };

    this.profiles.set(userId, profile);

    // Sync name back to user identity
    if (user.name !== profile.fullName) {
      await this.userSvc.updateUser(userId, { name: profile.fullName });
    }

    return profile;
  }

  public async updateProfile(
    userId: string,
    rawInput: unknown
  ): Promise<UserProfile> {
    const existing = this.profiles.get(userId);
    if (!existing) {
      throw new Error(`Profile for user '${userId}' not found; create it first`);
    }

    const validated = UpdateProfileInputSchema.parse(rawInput);

    const updated: UserProfile = {
      ...existing,
      ...validated,
      updatedAt: new Date(),
    };

    this.profiles.set(userId, updated);

    if (validated.fullName) {
      await this.userSvc.updateUser(userId, { name: validated.fullName });
    }

    return updated;
  }

  public clear(): void {
    this.profiles.clear();
  }
}

export const profileService = new ProfileService();

