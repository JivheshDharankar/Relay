import { createHash, randomBytes } from 'crypto';
import { AuthProviderType } from './types';

export interface OAuthStateData {
  state: string;
  provider: AuthProviderType;
  redirectUri: string;
  codeVerifier?: string;
  nonce?: string;
  createdAt: number;
  expiresAt: number;
}

export class OAuthStateManager {
  private states = new Map<string, OAuthStateData>();
  private readonly defaultTtlMs = 10 * 60 * 1000; // 10 minutes

  /**
   * Generates a cryptographically secure random state parameter for OAuth CSRF defense.
   */
  public createState(
    provider: AuthProviderType,
    redirectUri: string,
    options?: { codeVerifier?: string; nonce?: string; ttlMs?: number }
  ): string {
    this.cleanup();

    const state = `rly_st_${randomBytes(24).toString('base64url')}`;
    const now = Date.now();
    const ttlMs = options?.ttlMs ?? this.defaultTtlMs;

    this.states.set(state, {
      state,
      provider,
      redirectUri,
      codeVerifier: options?.codeVerifier,
      nonce: options?.nonce,
      createdAt: now,
      expiresAt: now + ttlMs,
    });

    return state;
  }

  /**
   * Generates PKCE code_verifier and code_challenge (S256).
   */
  public generatePkce(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
  }

  /**
   * Generates an OpenID Connect nonce.
   */
  public generateNonce(): string {
    return `rly_no_${randomBytes(16).toString('base64url')}`;
  }

  /**
   * Validates and single-use consumes the state parameter.
   * Guarantees single-use replay protection and CSRF validation.
   */
  public validateAndConsume(
    state: string,
    expectedProvider: AuthProviderType
  ): OAuthStateData | null {
    if (!state) return null;

    const data = this.states.get(state);
    if (!data) return null;

    // Single-use guarantee: consume immediately
    this.states.delete(state);

    // Verify expiration
    if (Date.now() > data.expiresAt) {
      return null;
    }

    // Verify provider match
    if (data.provider !== expectedProvider) {
      return null;
    }

    return data;
  }

  /**
   * Prunes expired states.
   */
  public cleanup(): void {
    const now = Date.now();
    for (const [key, value] of this.states.entries()) {
      if (now > value.expiresAt) {
        this.states.delete(key);
      }
    }
  }

  public clear(): void {
    this.states.clear();
  }
}

export const oauthStateManager = new OAuthStateManager();

