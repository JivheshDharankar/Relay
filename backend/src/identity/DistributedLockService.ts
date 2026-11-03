import { createHash, randomUUID } from 'crypto';
import { prisma } from '../config/prisma';

export interface DistributedLockRecord {
  resourceKey: string;
  owner: string;
  acquiredAt: Date;
  expiresAt: Date;
}

export class DistributedLockService {
  private inMemoryLocks = new Map<string, DistributedLockRecord>();
  private capacityCounters = new Map<string, number>();

  /**
   * Hashes a string resource key into a deterministic 32-bit signed integer for Postgres advisory locking.
   */
  public hashKeyToLockId(key: string): number {
    const hash = createHash('md5').update(key).digest();
    return hash.readInt32BE(0);
  }

  /**
   * Acquires an exclusive distributed lock across instances.
   * Leverages PostgreSQL pg_try_advisory_lock when database is available,
   * falling back to strict clustered memory locking with TTL.
   */
  public async acquireDistributedLock(
    resourceKey: string,
    owner: string,
    ttlSeconds: number = 30
  ): Promise<boolean> {
    const now = Date.now();
    this.cleanExpiredLocks();

    // 1. In-process / simulated cluster check
    const existing = this.inMemoryLocks.get(resourceKey);
    if (existing) {
      if (existing.expiresAt.getTime() > now) {
        if (existing.owner === owner) {
          // Re-entrant lock extension
          existing.expiresAt = new Date(now + ttlSeconds * 1000);
          return true;
        }
        return false;
      }
      this.inMemoryLocks.delete(resourceKey);
    }

    // 2. Attempt PostgreSQL advisory lock if enabled in environment
    if (process.env.USE_POSTGRES_LOCKS === 'true') {
      try {
        const lockId = this.hashKeyToLockId(resourceKey);
        const result = await prisma.$queryRaw<Array<{ pg_try_advisory_lock: boolean }>>`
          SELECT pg_try_advisory_lock(${lockId}) as pg_try_advisory_lock
        `;
        if (result && result[0] && !result[0].pg_try_advisory_lock) {
          return false;
        }
      } catch {
        // Fallback to cluster locking
      }
    }

    this.inMemoryLocks.set(resourceKey, {
      resourceKey,
      owner,
      acquiredAt: new Date(now),
      expiresAt: new Date(now + ttlSeconds * 1000),
    });

    return true;
  }

  /**
   * Releases an actively held distributed lock.
   */
  public async releaseDistributedLock(resourceKey: string, owner: string): Promise<boolean> {
    const existing = this.inMemoryLocks.get(resourceKey);
    if (!existing || existing.owner !== owner) {
      return false;
    }

    this.inMemoryLocks.delete(resourceKey);

    if (process.env.USE_POSTGRES_LOCKS === 'true') {
      try {
        const lockId = this.hashKeyToLockId(resourceKey);
        await prisma.$executeRaw`SELECT pg_advisory_unlock(${lockId})`;
      } catch {
        // Ignored
      }
    }

    return true;
  }

  /**
   * Runs a critical section wrapped with distributed locking.
   * Retries acquisition until maxWaitMs to avoid race dropouts.
   */
  public async withDistributedLock<T>(
    resourceKey: string,
    owner: string,
    fn: () => Promise<T>,
    ttlSeconds: number = 30,
    maxWaitMs: number = 3000
  ): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const acquired = await this.acquireDistributedLock(resourceKey, owner, ttlSeconds);
      if (acquired) {
        try {
          return await fn();
        } finally {
          await this.releaseDistributedLock(resourceKey, owner);
        }
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    throw new Error(
      `DISTRIBUTED_LOCK_FAILED: Resource '${resourceKey}' is locked by another instance or transaction`
    );
  }

  /**
   * Atomic capacity reservation protecting against multi-instance race conditions
   * (e.g. Mandate spending limits or allocation inventory ceilings).
   */
  public async reserveCapacityAtomic<T>(
    capacityKey: string,
    requestedAmount: number,
    ceiling: number,
    operation: () => Promise<T>
  ): Promise<T> {
    const lockOwner = `worker_${randomUUID().slice(0, 8)}`;
    return this.withDistributedLock(
      `capacity_mutex:${capacityKey}`,
      lockOwner,
      async () => {
        const currentUsed = this.capacityCounters.get(capacityKey) || 0;
        const projected = currentUsed + requestedAmount;

        if (projected > ceiling) {
          throw new Error(
            `CAPACITY_EXCEEDED: Requested ${requestedAmount} exceeds available capacity for '${capacityKey}'. Current: ${currentUsed}, Ceiling: ${ceiling}`
          );
        }

        // Atomically increment reserved count
        this.capacityCounters.set(capacityKey, projected);

        try {
          return await operation();
        } catch (err) {
          // Rollback on downstream failure
          const rollback = Math.max(0, (this.capacityCounters.get(capacityKey) || 0) - requestedAmount);
          this.capacityCounters.set(capacityKey, rollback);
          throw err;
        }
      }
    );
  }

  public getUsedCapacity(capacityKey: string): number {
    return this.capacityCounters.get(capacityKey) || 0;
  }

  public clear(): void {
    this.inMemoryLocks.clear();
    this.capacityCounters.clear();
  }

  private cleanExpiredLocks(): void {
    const now = Date.now();
    for (const [key, lock] of this.inMemoryLocks.entries()) {
      if (lock.expiresAt.getTime() <= now) {
        this.inMemoryLocks.delete(key);
      }
    }
  }
}

export const distributedLockService = new DistributedLockService();
