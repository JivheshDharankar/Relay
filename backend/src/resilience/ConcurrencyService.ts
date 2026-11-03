import { randomUUID } from 'crypto';
import { ConcurrencyLock } from './types';

export class ConcurrencyService {
  private activeLocks = new Map<string, ConcurrencyLock>();
  private resourceQueues = new Map<string, Promise<void>>();
  private reservedCapacities = new Map<string, number>();

  /**
   * Acquires an exclusive lock for a given resource key.
   * Returns ConcurrencyLock if acquired, or null if already locked.
   */
  public async acquireLock(
    resourceKey: string,
    owner: string,
    ttlMs: number = 30000
  ): Promise<ConcurrencyLock | null> {
    this.cleanExpiredLocks();

    const existing = this.activeLocks.get(resourceKey);
    if (existing) {
      if (existing.expiresAt.getTime() > Date.now()) {
        return null; // Already held by active owner
      }
      // Expired lock can be reclaimed
      this.activeLocks.delete(resourceKey);
    }

    const now = new Date();
    const lock: ConcurrencyLock = {
      lockId: randomUUID(),
      resourceKey,
      owner,
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    };

    this.activeLocks.set(resourceKey, lock);
    return lock;
  }

  /**
   * Releases an actively held lock by lockId.
   */
  public releaseLock(resourceKey: string, lockId: string): boolean {
    const existing = this.activeLocks.get(resourceKey);
    if (!existing) return false;
    if (existing.lockId !== lockId) return false;

    this.activeLocks.delete(resourceKey);
    return true;
  }

  /**
   * Executes a critical section wrapped with exclusive locking.
   * Serializes access to resourceKey across concurrent operations.
   */
  public async withLock<T>(
    resourceKey: string,
    owner: string,
    fn: () => Promise<T>,
    ttlMs: number = 30000
  ): Promise<T> {
    // Chain onto existing resource queue to serialize execution
    const prevPromise = this.resourceQueues.get(resourceKey) || Promise.resolve();

    let releaseQueue: () => void = () => {};
    const nextPromise = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    this.resourceQueues.set(resourceKey, nextPromise);

    await prevPromise;

    const lock = await this.acquireLock(resourceKey, owner, ttlMs);
    if (!lock) {
      releaseQueue();
      throw new Error(`Failed to acquire lock for resource '${resourceKey}' owned by '${owner}'`);
    }

    try {
      return await fn();
    } finally {
      this.releaseLock(resourceKey, lock.lockId);
      releaseQueue();
      if (this.resourceQueues.get(resourceKey) === nextPromise) {
        this.resourceQueues.delete(resourceKey);
      }
    }
  }

  /**
   * Concurrently-safe capacity reservation (e.g. for Mandate spending limits or inventory quotas).
   * Prevents concurrent race conditions where two simultaneous transactions exceed the ceiling.
   */
  public async reserveCapacityAtomic<T>(
    capacityKey: string,
    requestedAmount: number,
    maxCapacity: number,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.withLock(
      `capacity_mutex:${capacityKey}`,
      `capacity_worker_${randomUUID().slice(0, 8)}`,
      async () => {
        const currentReserved = this.reservedCapacities.get(capacityKey) || 0;
        const projected = currentReserved + requestedAmount;

        if (projected > maxCapacity) {
          throw new Error(
            `CAPACITY_EXCEEDED: Requested ${requestedAmount} exceeds available limit for '${capacityKey}'. Current: ${currentReserved}, Max: ${maxCapacity}`
          );
        }

        // Tentatively reserve capacity
        this.reservedCapacities.set(capacityKey, projected);

        try {
          const result = await operation();
          return result;
        } catch (err) {
          // Rollback reservation on failure
          const updated = (this.reservedCapacities.get(capacityKey) || 0) - requestedAmount;
          this.reservedCapacities.set(capacityKey, Math.max(0, updated));
          throw err;
        }
      }
    );
  }

  public getReservedCapacity(capacityKey: string): number {
    return this.reservedCapacities.get(capacityKey) || 0;
  }

  public isLocked(resourceKey: string): boolean {
    this.cleanExpiredLocks();
    return this.activeLocks.has(resourceKey);
  }

  public getLock(resourceKey: string): ConcurrencyLock | undefined {
    this.cleanExpiredLocks();
    return this.activeLocks.get(resourceKey);
  }

  public clear(): void {
    this.activeLocks.clear();
    this.resourceQueues.clear();
    this.reservedCapacities.clear();
  }

  private cleanExpiredLocks(): void {
    const now = Date.now();
    for (const [key, lock] of this.activeLocks.entries()) {
      if (lock.expiresAt.getTime() <= now) {
        this.activeLocks.delete(key);
      }
    }
  }
}

export const concurrencyService = new ConcurrencyService();

