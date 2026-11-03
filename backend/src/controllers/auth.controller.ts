import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import {
  LoginRequestSchema,
  RequestEmailOtpSchema,
  VerifyEmailOtpSchema,
  RequestPhoneOtpSchema,
  VerifyPhoneOtpSchema,
} from '../identity/validation';
import {
  authProviderRegistry,
  googleAuthProvider,
  emailPhoneAuthProvider,
} from '../identity/providers';
import { identityRehydrationService } from '../identity/IdentityRehydrationService';
import { sessionService } from '../identity/SessionService';
import { identityAuditService } from '../identity/IdentityAuditService';
import { oauthStateManager } from '../identity/OAuthStateManager';
import { oauthGrantService } from '../identity/OAuthGrantService';
import { userService } from '../identity/UserService';
import { extractToken } from '../middleware/auth.middleware';
import { UserIdentity } from '../identity/types';

export class AuthController {
  /**
   * GET /api/auth/providers
   * Returns public status and availability for all authentication paths.
   */
  public async getProviders(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const providers = authProviderRegistry.getAllMetadata();
      res.status(200).json({
        success: true,
        data: { providers },
      });
    } catch (err) {
      next(err);
    }
  }

  // =========================================================================
  // Google OAuth 2.0 / OpenID Connect
  // =========================================================================

  /**
   * GET /api/auth/google
   * Initiates Google OAuth authorization redirect.
   */
  public async initiateGoogle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!googleAuthProvider.isConfigured) {
        if (req.query.format === 'json' || req.headers.accept?.includes('application/json')) {
          res.status(503).json({
            success: false,
            error: {
              code: 'GOOGLE_AUTH_UNCONFIGURED',
              message: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in environment.',
              requiresConfig: true,
            },
          });
          return;
        }
        res.redirect(`${env.FRONTEND_URL}/login?error=GOOGLE_AUTH_UNCONFIGURED`);
        return;
      }

      const nonce = oauthStateManager.generateNonce();
      const { codeVerifier, codeChallenge } = oauthStateManager.generatePkce();
      const state = oauthStateManager.createState('GOOGLE', env.GOOGLE_REDIRECT_URI, {
        nonce,
        codeVerifier,
      });
      const authUrl = googleAuthProvider.getAuthorizationUrl(state, nonce, undefined, codeChallenge);

      if (req.query.format === 'json') {
        res.status(200).json({ success: true, data: { url: authUrl, state } });
        return;
      }

      res.redirect(authUrl);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/auth/google/callback
   * Handles Google OAuth callback and session creation.
   */
  /**
   * Renders an OAuth callback failure. Browser navigations (Accept: text/html)
   * are redirected to the login page with a safe error code, which the login
   * form already displays; API callers keep the JSON error envelope.
   */
  private oauthCallbackFailure(req: Request, res: Response, status: number, code: string, message: string): void {
    const wantsHtml = req.headers.accept?.includes('text/html') ?? false;
    if (wantsHtml) {
      res.redirect(`${env.FRONTEND_URL}/login?error=${encodeURIComponent(code)}`);
      return;
    }
    res.status(status).json({
      success: false,
      error: { code, message },
    });
  }

  public async handleGoogleCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code, state, error, error_description } = req.query as Record<string, string | undefined>;

      if (error) {
        this.oauthCallbackFailure(req, res, 400, 'OAUTH_PROVIDER_ERROR', error_description || error);
        return;
      }

      if (!code || !state) {
        this.oauthCallbackFailure(req, res, 400, 'MISSING_OAUTH_PARAMS', 'Missing authorization code or state in callback');
        return;
      }

      // CSRF Defense: Single-use state consumption
      const stateData = oauthStateManager.validateAndConsume(state, 'GOOGLE');
      if (!stateData) {
        this.oauthCallbackFailure(req, res, 400, 'INVALID_OAUTH_STATE', 'OAuth state is invalid or has expired');
        return;
      }

      // Authorization-code exchange (PKCE-bound to the initiation request)
      const authResult = await googleAuthProvider.handleCallback({
        code,
        redirectUri: stateData.redirectUri,
        nonce: stateData.nonce,
        codeVerifier: stateData.codeVerifier,
      });

      if (!authResult.success) {
        this.oauthCallbackFailure(
          req,
          res,
          401,
          authResult.errorCode || 'GOOGLE_AUTH_FAILED',
          authResult.errorMessage || 'Google authentication failed'
        );
        return;
      }

      await this.completeOAuthLogin(req, res, authResult.user!);
    } catch (err: any) {
      if (err.code === 'ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER') {
        this.oauthCallbackFailure(req, res, 409, 'ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER', err.message);
        return;
      }
      next(err);
    }
  }

  /**
   * POST /api/auth/oauth/exchange
   * Exchanges a single-use OAuth grant code (delivered via the callback
   * redirect URL) for the session. The session token itself never travels in
   * URLs; grant codes are random, single-use, and expire after 5 minutes.
   */
  public async exchangeOAuthGrant(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      const grant = oauthGrantService.consumeGrant(code);
      if (!grant) {
        res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_OAUTH_GRANT',
            message: 'OAuth grant is invalid, expired, or already used',
          },
        });
        return;
      }

      const validation = await sessionService.validateSession(grant.sessionToken);
      const user = await userService.getUserById(grant.userId);
      if (!validation.valid || !validation.session || !user) {
        res.status(401).json({
          success: false,
          error: { code: 'INVALID_OAUTH_GRANT', message: 'OAuth grant session is no longer valid' },
        });
        return;
      }

      identityAuditService.emit('USER_AUTHENTICATED', user.id, {
        provider: user.authProvider,
        via: 'oauth_grant_exchange',
      });

      res.status(200).json({
        success: true,
        data: {
          user: {
            id: user.id,
            authProvider: user.authProvider,
            email: user.email,
            phone: user.phone,
            name: user.name,
            profileImage: user.profileImage,
            onboardingStatus: user.onboardingStatus,
            residentId: user.residentId,
          },
          session: {
            token: validation.session.token,
            expiresAt: validation.session.expiresAt,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }

  // =========================================================================
  // Dedicated Email OTP
  // =========================================================================

  /**
   * POST /api/auth/email/request-otp
   */
  public async requestEmailOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = RequestEmailOtpSchema.parse(req.body);
      const result = await emailPhoneAuthProvider.sendEmailOtp(validated.email);

      res.status(200).json({
        success: true,
        data: {
          message: 'OTP dispatched successfully to email',
          messageId: result.messageId,
          cooldownSeconds: result.cooldownSeconds,
        },
      });
    } catch (err: any) {
      if (err.message?.includes('OTP_COOLDOWN_ACTIVE')) {
        res.status(429).json({
          success: false,
          error: { code: 'OTP_COOLDOWN_ACTIVE', message: err.message },
        });
        return;
      }
      next(err);
    }
  }

  /**
   * POST /api/auth/email/verify-otp
   */
  public async verifyEmailOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = VerifyEmailOtpSchema.parse(req.body);

      const authResult = await emailPhoneAuthProvider.authenticate({
        provider: 'EMAIL',
        email: validated.email,
        otpCode: validated.otpCode,
      });

      if (!authResult.success) {
        res.status(401).json({
          success: false,
          error: {
            code: authResult.errorCode || 'INVALID_OTP',
            message: authResult.errorMessage || 'Invalid OTP code',
          },
        });
        return;
      }

      await this.completeSessionLogin(req, res, authResult.user!);
    } catch (err: any) {
      if (err.code === 'ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER') {
        res.status(409).json({
          success: false,
          error: { code: 'ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER', message: err.message },
        });
        return;
      }
      next(err);
    }
  }

  // =========================================================================
  // Dedicated Phone OTP
  // =========================================================================

  /**
   * POST /api/auth/phone/request-otp
   */
  public async requestPhoneOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = RequestPhoneOtpSchema.parse(req.body);
      const result = await emailPhoneAuthProvider.sendPhoneOtp(validated.phone);

      res.status(200).json({
        success: true,
        data: {
          message: 'OTP dispatched successfully to phone',
          messageId: result.messageId,
          cooldownSeconds: result.cooldownSeconds,
        },
      });
    } catch (err: any) {
      if (err.message?.includes('OTP_COOLDOWN_ACTIVE')) {
        res.status(429).json({
          success: false,
          error: { code: 'OTP_COOLDOWN_ACTIVE', message: err.message },
        });
        return;
      }
      next(err);
    }
  }

  /**
   * POST /api/auth/phone/verify-otp
   */
  public async verifyPhoneOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = VerifyPhoneOtpSchema.parse(req.body);

      const authResult = await emailPhoneAuthProvider.authenticate({
        provider: 'PHONE',
        phone: validated.phone,
        otpCode: validated.otpCode,
      });

      if (!authResult.success) {
        res.status(401).json({
          success: false,
          error: {
            code: authResult.errorCode || 'INVALID_OTP',
            message: authResult.errorMessage || 'Invalid OTP code',
          },
        });
        return;
      }

      await this.completeSessionLogin(req, res, authResult.user!);
    } catch (err: any) {
      if (err.code === 'ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER') {
        res.status(409).json({
          success: false,
          error: { code: 'ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER', message: err.message },
        });
        return;
      }
      next(err);
    }
  }

  // =========================================================================
  // Phase 12 Legacy Endpoints (Fully Maintained for Backward Compatibility)
  // =========================================================================

  /**
   * POST /api/auth/send-otp
   */
  public async sendOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const destination = req.body.email || req.body.phone || req.body.destination;
      if (!destination) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_DESTINATION', message: 'Email or phone number is required' },
        });
        return;
      }

      const result = await emailPhoneAuthProvider.sendOtp(destination);
      res.status(200).json({
        success: true,
        data: { message: 'OTP dispatched successfully', messageId: result.messageId },
      });
    } catch (err: any) {
      if (err.message?.includes('OTP_COOLDOWN_ACTIVE')) {
        res.status(429).json({
          success: false,
          error: { code: 'OTP_COOLDOWN_ACTIVE', message: err.message },
        });
        return;
      }
      next(err);
    }
  }

  /**
   * POST /api/auth/login
   */
  public async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = LoginRequestSchema.parse(req.body);
      const provider = authProviderRegistry.get(validated.provider);

      if (!provider) {
        res.status(400).json({
          success: false,
          error: {
            code: 'UNSUPPORTED_PROVIDER',
            message: `Authentication provider '${validated.provider}' is not supported`,
          },
        });
        return;
      }

      const authResult = await provider.authenticate(validated);

      if (!authResult.success) {
        if (authResult.requiresConfig) {
          res.status(503).json({
            success: false,
            error: {
              code: authResult.errorCode || 'PROVIDER_UNCONFIGURED',
              message: authResult.errorMessage || 'Provider requires configuration in environment',
              requiresConfig: true,
            },
          });
          return;
        }

        res.status(401).json({
          success: false,
          error: {
            code: authResult.errorCode || 'AUTHENTICATION_FAILED',
            message: authResult.errorMessage || 'Authentication failed',
          },
        });
        return;
      }

      await this.completeSessionLogin(req, res, authResult.user!);
    } catch (err: any) {
      if (err.code === 'ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER') {
        res.status(409).json({
          success: false,
          error: { code: 'ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER', message: err.message },
        });
        return;
      }
      next(err);
    }
  }

  /**
   * GET /api/auth/session
   */
  public async getSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || !req.session) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'No active session' },
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          user: req.user,
          residentId: req.residentId,
          session: {
            sessionId: req.session.sessionId,
            expiresAt: req.session.expiresAt,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/auth/logout
   */
  public async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const token = req.session?.token || extractToken(req);

      if (token) {
        const validation = await sessionService.validateSession(token);
        await sessionService.revokeSession(token);
        const userId = req.user?.id || validation.session?.userId;
        if (userId) {
          identityAuditService.emit('USER_LOGGED_OUT', userId);
        }
      }

      res.clearCookie('relay_session');
      res.status(200).json({
        success: true,
        data: { message: 'Logged out successfully' },
      });
    } catch (err) {
      next(err);
    }
  }

  // =========================================================================
  // Internal Session & Login Helpers
  // =========================================================================

  private async completeSessionLogin(req: Request, res: Response, providerUser: UserIdentity): Promise<void> {
    // Durable resolution: returning users are rehydrated with their canonical
    // ids; only genuinely new identities enter creation.
    const { user, isNewUser } = await identityRehydrationService.resolveUser(providerUser);

    const session = await sessionService.createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });

    identityAuditService.emit('USER_AUTHENTICATED', user.id, {
      provider: user.authProvider,
      isNewUser,
      onboardingStatus: user.onboardingStatus,
    });

    res.cookie('relay_session', session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 3600 * 1000,
    });

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id,
          authProvider: user.authProvider,
          email: user.email,
          phone: user.phone,
          name: user.name,
          profileImage: user.profileImage,
          onboardingStatus: user.onboardingStatus,
          residentId: user.residentId,
        },
        session: {
          token: session.token,
          expiresAt: session.expiresAt,
        },
        isNewUser,
      },
    });
  }

  private async completeOAuthLogin(req: Request, res: Response, providerUser: UserIdentity): Promise<void> {
    // Durable resolution: returning users are rehydrated with their canonical
    // ids; only genuinely new identities enter creation.
    const { user, isNewUser } = await identityRehydrationService.resolveUser(providerUser);

    const session = await sessionService.createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });

    identityAuditService.emit('USER_AUTHENTICATED', user.id, {
      provider: user.authProvider,
      isNewUser,
      onboardingStatus: user.onboardingStatus,
    });

    res.cookie('relay_session', session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 3600 * 1000,
    });

    // Support JSON response when requested
    if (req.headers.accept?.includes('application/json')) {
      res.status(200).json({
        success: true,
        data: {
          user,
          session: {
            token: session.token,
            expiresAt: session.expiresAt,
          },
          isNewUser,
        },
      });
      return;
    }

    // Otherwise redirect browser to frontend onboarding or home. The URL
    // carries only a single-use grant code — never the session token.
    const redirectPath = user.onboardingStatus === 'ONBOARDING_COMPLETE' ? '/' : '/onboarding';
    const grantCode = oauthGrantService.issueGrant(session.token, user.id);
    res.redirect(`${env.FRONTEND_URL}${redirectPath}?oauthGrant=${grantCode}`);
  }
}

export const authController = new AuthController();
