import { IdempotencyRecord } from './types';

export interface IdempotentExecutionOptions {
  ttlMs?: number;
  allowRetryOnFailure?: boolean;
}

export class IdempotencyService {
  private records = new Map<string, IdempotencyRecord>();
  private inFlightPromises = new Map<string, Promise<unknown>>();

  /**
   * Executes an asynchronous operation idempotently.
   *
   * Invariants:
   * 1. If key was previously completed successfully, returns cached result immediately without invoking operation.
   * 2. If key is currently IN_FLIGHT, coalesces concurrent calls to the same in-flight Promise so execution happens exactly once.
   * 3. Prevents duplicate state changes or financial double charges.
   */
  public async executeIdempotent<T>(
    key: string,
    operation: () => Promise<T>,
    options: IdempotentExecutionOptions = {}
  ): Promise<T> {
    if (!key || key.trim() === '') {
      throw new Error('Idempotency key must be a non-empty string');
    }

    const { ttlMs, allowRetryOnFailure = true } = options;

    // 1. Check existing record
    const existing = this.records.get(key);
    if (existing) {
      if (existing.expiresAt && existing.expiresAt.getTime() < Date.now()) {
        this.records.delete(key);
      } else if (existing.status === 'COMPLETED') {
        return existing.result as T;
      } else if (existing.status === 'FAILED' && !allowRetryOnFailure) {
        throw new Error(existing.error || `Previous idempotent execution failed for key '${key}'`);
      }
    }

    // 2. In-flight promise coalescing
    const inFlight = this.inFlightPromises.get(key);
    if (inFlight) {
      return (await inFlight) as T;
    }

    // 3. Mark in-flight
    const now = new Date();
    const record: IdempotencyRecord<T> = {
      key,
      status: 'IN_FLIGHT',
      createdAt: now,
      updatedAt: now,
      expiresAt: ttlMs ? new Date(now.getTime() + ttlMs) : undefined,
    };
    this.records.set(key, record);

    const promise = (async () => {
      try {
        const result = await operation();
        record.status = 'COMPLETED';
        record.result = result;
        record.updatedAt = new Date();
        return result;
      } catch (err) {
        record.status = 'FAILED';
        record.error = err instanceof Error ? err.message : String(err);
        record.updatedAt = new Date();
        throw err;
      } finally {
        this.inFlightPromises.delete(key);
      }
    })();

    this.inFlightPromises.set(key, promise);
    return await promise;
  }

  public getRecord(key: string): IdempotencyRecord | undefined {
    return this.records.get(key);
  }

  public has(key: string): boolean {
    const rec = this.records.get(key);
    if (!rec) return false;
    if (rec.expiresAt && rec.expiresAt.getTime() < Date.now()) {
      this.records.delete(key);
      return false;
    }
    return true;
  }

  public delete(key: string): boolean {
    this.inFlightPromises.delete(key);
    return this.records.delete(key);
  }

  public clear(): void {
    this.records.clear();
    this.inFlightPromises.clear();
  }

  public size(): number {
    return this.records.size;
  }
}

export const idempotencyService = new IdempotencyService();

