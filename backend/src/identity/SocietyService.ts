import { randomUUID } from 'crypto';
import { Society, SocietyVerificationStatus } from './types';
import { CreateSocietyInputSchema, SocietySearchQuerySchema } from './validation';

export class SocietyService {
  private societies = new Map<string, Society>(); // societyId -> Society

  /**
   * Registers a new society dynamically.
   * If not administratively verified, defaults honestly to PENDING_VERIFICATION.
   */
  public async registerSociety(
    rawInput: unknown,
    options: { verificationStatus?: SocietyVerificationStatus } = {}
  ): Promise<Society> {
    const validated = CreateSocietyInputSchema.parse(rawInput);
    const societyId = `soc_${randomUUID().slice(0, 10)}`;
    const now = new Date();

    const society: Society = {
      id: societyId,
      name: validated.name,
      address: validated.address,
      city: validated.city,
      state: validated.state,
      postalCode: validated.postalCode,
      country: validated.country,
      latitude: validated.latitude,
      longitude: validated.longitude,
      verificationStatus: options.verificationStatus || 'PENDING_VERIFICATION',
      createdAt: now,
      updatedAt: now,
    };

    this.societies.set(societyId, society);
    return society;
  }

  public async getSocietyById(societyId: string): Promise<Society | undefined> {
    return this.societies.get(societyId);
  }

  /**
   * Server-side only restoration of a society already persisted in PostgreSQL.
   * Reuses the canonical id verbatim so procurement upserts the same row.
   * Idempotent on the society id. Never accepts client input.
   */
  public async restoreSociety(input: {
    id: string;
    name: string;
    address: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    latitude: number;
    longitude: number;
  }): Promise<Society> {
    const existing = this.societies.get(input.id);
    if (existing) return existing;
    const now = new Date();
    // Normal onboarding leaves societies PENDING_VERIFICATION and nothing in
    // the procurement path gates on society verification, so restoring the
    // default is both faithful and safe.
    const society: Society = {
      ...input,
      verificationStatus: 'PENDING_VERIFICATION',
      createdAt: now,
      updatedAt: now,
    };
    this.societies.set(input.id, society);
    return society;
  }

  /**
   * Dynamically searches societies by name, city, postal code, or geographic proximity.
   * Eliminates hardcoded frontend dropdowns.
   */
  public async searchSocieties(rawQuery: unknown): Promise<Society[]> {
    const validated = SocietySearchQuerySchema.parse(rawQuery);
    const all = Array.from(this.societies.values());

    return all
      .filter((soc) => {
        if (validated.query) {
          const q = validated.query.toLowerCase();
          const matchesName = soc.name.toLowerCase().includes(q);
          const matchesAddress = soc.address.toLowerCase().includes(q);
          if (!matchesName && !matchesAddress) return false;
        }

        if (validated.city && soc.city.toLowerCase() !== validated.city.toLowerCase()) {
          return false;
        }

        if (validated.postalCode && soc.postalCode !== validated.postalCode) {
          return false;
        }

        if (validated.latitude !== undefined && validated.longitude !== undefined) {
          const distKm = this.calculateDistanceKm(
            validated.latitude,
            validated.longitude,
            soc.latitude,
            soc.longitude
          );
          if (distKm > validated.radiusKm) {
            return false;
          }
        }

        return true;
      })
      .slice(0, validated.limit);
  }

  public async setVerificationStatus(
    societyId: string,
    status: SocietyVerificationStatus
  ): Promise<Society> {
    const society = this.societies.get(societyId);
    if (!society) {
      throw new Error(`Society '${societyId}' not found`);
    }

    society.verificationStatus = status;
    society.updatedAt = new Date();
    return society;
  }

  public listAll(): Society[] {
    return Array.from(this.societies.values());
  }

  public clear(): void {
    this.societies.clear();
  }

  private calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's radius in km
    const dLat = this.deg2rad(lat2 - lat1);
    const dLon = this.deg2rad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.deg2rad(lat1)) *
        Math.cos(this.deg2rad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private deg2rad(deg: number): number {
    return deg * (Math.PI / 180);
  }
}

export const societyService = new SocietyService();

