import { BackoffResult, RetryPolicy } from './types';

export class RetryBackoffService {
  /**
   * Computes bounded exponential backoff delay with jitter.
   */
  public calculateBackoff(
    attempt: number,
    policy: Partial<RetryPolicy> = {},
    customRandom?: number
  ): BackoffResult {
    return this.computeBackoff(attempt, policy, customRandom);
  }

  /**
   * Computes bounded exponential backoff delay with jitter.
   *
   * Formula:
   * rawDelay = min(maxBackoffMs, initialBackoffMs * multiplier^(attempt - 1))
   * jitteredDelay = jitter ? (rawDelay + rand * 0.25 * rawDelay) : rawDelay
   */
  public computeBackoff(
    attempt: number,
    policy: Partial<RetryPolicy> = {},
    customRandom?: number
  ): BackoffResult {
    const initialBackoffMs = policy.initialBackoffMs ?? 500;
    const maxBackoffMs = policy.maxBackoffMs ?? 10000;
    const backoffMultiplier = policy.backoffMultiplier ?? 2.0;
    const useJitter = policy.jitter ?? true;

    const clampedAttempt = Math.max(1, attempt);
    const exponent = clampedAttempt - 1;
    const rawBackoff = Math.min(
      maxBackoffMs,
      Math.round(initialBackoffMs * Math.pow(backoffMultiplier, exponent))
    );

    let jitterMs = 0;
    let totalDelayMs = rawBackoff;

    if (useJitter) {
      const rand = customRandom !== undefined ? customRandom : Math.random();
      // Jitter uniformly between 0 and 25% of raw backoff
      jitterMs = Math.round(rand * (rawBackoff * 0.25));
      totalDelayMs = rawBackoff + jitterMs;
    }

    return {
      attempt: clampedAttempt,
      backoffMs: rawBackoff,
      jitterMs,
      totalDelayMs,
    };
  }

  /**
   * Asynchronously pauses execution for the computed backoff duration.
   */
  public async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const retryBackoffService = new RetryBackoffService();
