import { randomUUID } from 'crypto';
import { UserAddress } from './types';
import { CreateAddressInputSchema } from './validation';
import { userService, UserService } from './UserService';

export class AddressService {
  private addresses = new Map<string, UserAddress>(); // addressId -> UserAddress
  private userAddresses = new Map<string, string[]>(); // userId -> addressId[]

  constructor(private readonly userSvc: UserService = userService) {}

  public async getAddresses(userId: string): Promise<UserAddress[]> {
    const ids = this.userAddresses.get(userId) || [];
    return ids
      .map((id) => this.addresses.get(id))
      .filter((addr): addr is UserAddress => Boolean(addr));
  }

  public async getDefaultAddress(userId: string): Promise<UserAddress | undefined> {
    const list = await this.getAddresses(userId);
    return list.find((a) => a.isDefault) || list[0];
  }

  public async addAddress(userId: string, rawInput: unknown): Promise<UserAddress> {
    const user = await this.userSvc.getUserById(userId);
    if (!user) {
      throw new Error(`Cannot add address: User '${userId}' does not exist`);
    }

    const validated = CreateAddressInputSchema.parse(rawInput);
    const addressId = `addr_${randomUUID().slice(0, 10)}`;
    const now = new Date();

    const existingList = this.userAddresses.get(userId) || [];
    // If it's the first address or explicitly marked default, make it default
    const isDefault = validated.isDefault || existingList.length === 0;

    if (isDefault) {
      // Unset previous defaults
      for (const id of existingList) {
        const existing = this.addresses.get(id);
        if (existing && existing.isDefault) {
          existing.isDefault = false;
        }
      }
    }

    const address: UserAddress = {
      id: addressId,
      userId,
      addressLine: validated.addressLine,
      city: validated.city,
      state: validated.state,
      postalCode: validated.postalCode,
      country: validated.country,
      latitude: validated.latitude,
      longitude: validated.longitude,
      isDefault,
      createdAt: now,
      updatedAt: now,
    };

    this.addresses.set(addressId, address);
    this.userAddresses.set(userId, [...existingList, addressId]);

    return address;
  }

  public async setDefaultAddress(userId: string, addressId: string): Promise<UserAddress> {
    const address = this.addresses.get(addressId);
    if (!address || address.userId !== userId) {
      throw new Error(`Address '${addressId}' not found for user '${userId}'`);
    }

    const existingList = this.userAddresses.get(userId) || [];
    for (const id of existingList) {
      const addr = this.addresses.get(id);
      if (addr) {
        addr.isDefault = addr.id === addressId;
      }
    }

    return address;
  }

  public async deleteAddress(userId: string, addressId: string): Promise<boolean> {
    const address = this.addresses.get(addressId);
    if (!address || address.userId !== userId) {
      return false;
    }

    this.addresses.delete(addressId);
    const existingList = this.userAddresses.get(userId) || [];
    this.userAddresses.set(
      userId,
      existingList.filter((id) => id !== addressId)
    );

    return true;
  }

  public clear(): void {
    this.addresses.clear();
    this.userAddresses.clear();
  }
}

export const addressService = new AddressService();

