import { env } from '../../config/env';
import { AuthCredentials, AuthResult, ProviderMetadata, ProviderStatus } from '../types';
import { AuthProvider } from './AuthProvider';

export interface GoogleConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  fetchFn?: typeof fetch;
}

export class GoogleAuthProvider implements AuthProvider {
  public readonly providerName = 'GOOGLE';
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly redirectUri: string;
  private readonly fetchFn: typeof fetch;

  constructor(
    clientIdOrConfig?: string | GoogleConfig,
    clientSecret?: string,
    redirectUri?: string,
    fetchFn?: typeof fetch
  ) {
    if (typeof clientIdOrConfig === 'object' && clientIdOrConfig !== null) {
      this.clientId = 'clientId' in clientIdOrConfig ? clientIdOrConfig.clientId : env.GOOGLE_CLIENT_ID;
      this.clientSecret = 'clientSecret' in clientIdOrConfig ? clientIdOrConfig.clientSecret : env.GOOGLE_CLIENT_SECRET;
      this.redirectUri = clientIdOrConfig.redirectUri ?? env.GOOGLE_REDIRECT_URI;
      this.fetchFn = clientIdOrConfig.fetchFn ?? globalThis.fetch;
    } else if (arguments.length > 0) {
      this.clientId = clientIdOrConfig;
      this.clientSecret = clientSecret;
      this.redirectUri = redirectUri ?? env.GOOGLE_REDIRECT_URI;
      this.fetchFn = fetchFn ?? globalThis.fetch;
    } else {
      this.clientId = env.GOOGLE_CLIENT_ID;
      this.clientSecret = env.GOOGLE_CLIENT_SECRET;
      this.redirectUri = env.GOOGLE_REDIRECT_URI;
      this.fetchFn = globalThis.fetch;
    }
  }

  public get isConfigured(): boolean {
    return Boolean(
      this.clientId &&
      this.clientSecret &&
      this.clientId.trim().length > 0 &&
      this.clientSecret.trim().length > 0
    );
  }

  public get status(): ProviderStatus {
    return this.isConfigured ? 'CONFIGURED' : 'UNCONFIGURED';
  }

  public getMetadata(): ProviderMetadata {
    return {
      id: 'GOOGLE',
      name: 'Google',
      type: 'OAUTH',
      status: this.status,
      isAvailable: this.isConfigured,
      requiresConfig: !this.isConfigured,
      authorizationUrl: this.isConfigured ? '/api/auth/google' : undefined,
      errorMessage: this.isConfigured
        ? undefined
        : 'Google OAuth credentials not configured in environment',
    };
  }

  /**
   * Generates official Google OAuth 2.0 / OpenID Connect authorization URL,
   * with PKCE (S256) when a code challenge is supplied.
   */
  public getAuthorizationUrl(
    state: string,
    nonce?: string,
    customRedirectUri?: string,
    codeChallenge?: string
  ): string {
    if (!this.isConfigured) {
      throw new Error('GOOGLE_AUTH_UNCONFIGURED: Google OAuth is not configured');
    }

    const uri = customRedirectUri || this.redirectUri;
    const params = new URLSearchParams({
      client_id: this.clientId!,
      redirect_uri: uri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'offline',
      prompt: 'select_account',
    });

    if (nonce) {
      params.append('nonce', nonce);
    }

    if (codeChallenge) {
      params.append('code_challenge', codeChallenge);
      params.append('code_challenge_method', 'S256');
    }

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Handles Google OAuth authorization-code exchange and identity extraction.
   * Never fabricates successful authentication when credentials are missing or invalid.
   */
  public async handleCallback(params: {
    code: string;
    redirectUri?: string;
    nonce?: string;
    codeVerifier?: string;
  }): Promise<AuthResult> {
    if (!this.isConfigured) {
      return {
        success: false,
        requiresConfig: true,
        errorCode: 'GOOGLE_AUTH_UNCONFIGURED',
        errorMessage: 'Google OAuth provider credentials missing from environment',
      };
    }

    if (!params.code || params.code.trim().length === 0) {
      return {
        success: false,
        errorCode: 'MISSING_AUTHORIZATION_CODE',
        errorMessage: 'Authorization code is missing from Google callback',
      };
    }

    const uri = params.redirectUri || this.redirectUri;

    try {
      // 1. Authorization-code exchange (with PKCE verifier when the flow
      // initiated one — binds the exchange to the original request).
      const tokenUrl = 'https://oauth2.googleapis.com/token';
      const bodyParams = new URLSearchParams({
        code: params.code,
        client_id: this.clientId!,
        client_secret: this.clientSecret!,
        redirect_uri: uri,
        grant_type: 'authorization_code',
      });
      if (params.codeVerifier) {
        bodyParams.append('code_verifier', params.codeVerifier);
      }

      const tokenRes = await this.fetchFn(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: bodyParams.toString(),
      });

      if (!tokenRes.ok) {
        const errorText = await tokenRes.text();
        return {
          success: false,
          errorCode: 'GOOGLE_TOKEN_EXCHANGE_FAILED',
          errorMessage: `Google token exchange failed (${tokenRes.status}): ${errorText}`,
        };
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        id_token?: string;
        error?: string;
        error_description?: string;
      };

      if (!tokenData.access_token && !tokenData.id_token) {
        return {
          success: false,
          errorCode: 'GOOGLE_TOKEN_MISSING',
          errorMessage: tokenData.error_description || 'No access_token or id_token returned by Google',
        };
      }

      // 2. Fetch User Profile from Google UserInfo endpoint
      let sub = '';
      let email = '';
      let name = 'Google User';
      let picture: string | undefined;

      if (tokenData.access_token) {
        const userInfoRes = await this.fetchFn('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });

        if (userInfoRes.ok) {
          const userInfo = (await userInfoRes.json()) as {
            sub: string;
            email?: string;
            name?: string;
            picture?: string;
          };
          sub = userInfo.sub;
          email = userInfo.email || '';
          name = userInfo.name || name;
          picture = userInfo.picture;
        }
      }

      // If userinfo didn't provide sub, verify the id_token with Google and
      // use ONLY the verified claims. Unverified JWT decoding is never a
      // fallback for identity.
      if (!sub && tokenData.id_token) {
        const verified = await this.verifyIdTokenWithGoogle(tokenData.id_token);
        if (verified) {
          sub = verified.sub;
          email = email || verified.email || '';
          name = verified.name || name;
          picture = picture || verified.picture;
        }
      }

      if (!sub) {
        return {
          success: false,
          errorCode: 'GOOGLE_IDENTITY_EXTRACTION_FAILED',
          errorMessage: 'Could not extract authoritative Google user identity',
        };
      }

      const providerAccountId = `g_${sub}`;
      const userEmail = email || `user_${sub}@gmail.com`;

      return {
        success: true,
        requiresConfig: false,
        user: {
          id: `usr_${providerAccountId}`,
          authProvider: 'GOOGLE',
          providerAccountId,
          email: userEmail,
          name,
          profileImage: picture,
          onboardingStatus: 'AUTHENTICATED',
          residentId: `res_usr_${providerAccountId}`,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };
    } catch (err: any) {
      return {
        success: false,
        errorCode: 'GOOGLE_AUTH_ERROR',
        errorMessage: err.message || 'Error occurred during Google OAuth exchange',
      };
    }
  }

  /**
   * Direct credential authentication.
   *
   * The idToken is verified with Google's tokeninfo endpoint and the identity
   * is derived ONLY from Google's verified response. Client-supplied
   * email/name/providerAccountId are never trusted.
   */
  public async authenticate(credentials: AuthCredentials): Promise<AuthResult> {
    if (!this.isConfigured) {
      return {
        success: false,
        requiresConfig: true,
        errorCode: 'GOOGLE_AUTH_UNCONFIGURED',
        errorMessage:
          'Google OAuth provider is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in environment.',
      };
    }

    if (!credentials.idToken) {
      return {
        success: false,
        errorCode: 'MISSING_TOKEN',
        errorMessage: 'Google idToken is required for authentication',
      };
    }

    if (credentials.idToken.startsWith('mock_invalid') || credentials.idToken.length < 10) {
      return {
        success: false,
        errorCode: 'INVALID_ID_TOKEN',
        errorMessage: 'Invalid Google idToken signature or payload',
      };
    }

    const verified = await this.verifyIdTokenWithGoogle(credentials.idToken);
    if (!verified) {
      return {
        success: false,
        errorCode: 'INVALID_ID_TOKEN',
        errorMessage: 'Google idToken failed verification with Google',
      };
    }

    const providerAccountId = `g_${verified.sub}`;
    const email = verified.email || `user_${verified.sub}@gmail.com`;
    const name = verified.name || 'Google User';

    return {
      success: true,
      requiresConfig: false,
      user: {
        id: `usr_${providerAccountId}`,
        authProvider: 'GOOGLE',
        providerAccountId,
        email,
        name,
        profileImage: verified.picture,
        onboardingStatus: 'AUTHENTICATED',
        residentId: `res_usr_${providerAccountId}`,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };
  }

  /**
   * Verifies an idToken with Google. Returns the verified identity claims, or
   * null when the token is invalid, expired, issued for a different audience,
   * or otherwise unverifiable. Never throws for untrusted input.
   */
  private async verifyIdTokenWithGoogle(
    idToken: string
  ): Promise<{ sub: string; email?: string; name?: string; picture?: string } | null> {
    try {
      const res = await this.fetchFn(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
      );
      if (!res.ok) return null;
      const info = (await res.json()) as {
        sub?: string;
        aud?: string;
        exp?: string;
        email?: string;
        name?: string;
        picture?: string;
        iss?: string;
      };
      if (!info || typeof info.sub !== 'string' || info.sub.length === 0) return null;
      if (info.aud !== this.clientId) return null;
      if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') {
        return null;
      }
      const exp = Number(info.exp);
      if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return null;
      return { sub: info.sub, email: info.email, name: info.name, picture: info.picture };
    } catch {
      return null;
    }
  }
}

export const googleAuthProvider = new GoogleAuthProvider();
