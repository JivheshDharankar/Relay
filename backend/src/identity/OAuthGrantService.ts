import { randomBytes } from 'crypto';

export interface OAuthGrantData {
  code: string;
  sessionToken: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Single-use OAuth login grants.
 *
 * The OAuth callback redirects through the browser, so the session token
 * itself must never travel in the redirect URL (history, logs, referer).
 * Instead the callback mints a short-lived one-time grant code; the frontend
 * exchanges it server-to-server for the session. Grants are random,
 * single-use, and expire after 5 minutes.
 */
export class OAuthGrantService {
  private grants = new Map<string, OAuthGrantData>();
  private readonly ttlMs = 5 * 60 * 1000;

  public issueGrant(sessionToken: string, userId: string): string {
    this.cleanup();
    const code = `rly_gr_${randomBytes(24).toString('base64url')}`;
    const now = Date.now();
    this.grants.set(code, {
      code,
      sessionToken,
      userId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });
    return code;
  }

  /**
   * Validates and single-use consumes a grant code. Returns null when the
   * code is unknown, expired, or already consumed (replay rejected).
   */
  public consumeGrant(code: string): OAuthGrantData | null {
    if (!code) return null;
    const data = this.grants.get(code);
    if (!data) return null;
    this.grants.delete(code);
    if (Date.now() > data.expiresAt) {
      return null;
    }
    return data;
  }

  public clear(): void {
    this.grants.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [code, data] of this.grants) {
      if (now > data.expiresAt) {
        this.grants.delete(code);
      }
    }
  }
}

export const oauthGrantService = new OAuthGrantService();
