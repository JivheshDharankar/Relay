import { apiClient, API_BASE_URL } from './client';

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export interface AuthProviderMetadata {
  id: 'GOOGLE' | 'EMAIL_PHONE' | 'EMAIL' | 'PHONE';
  name: string;
  type: 'OAUTH' | 'OTP';
  status: 'CONFIGURED' | 'UNCONFIGURED' | 'ERROR';
  isAvailable: boolean;
  requiresConfig: boolean;
  authorizationUrl?: string;
  errorMessage?: string;
}

export interface SessionUser {
  id: string;
  authProvider: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  profileImage: string | null;
  onboardingStatus: string;
  residentId: string | null;
}

export interface SessionInfo {
  user: SessionUser;
  residentId: string | null;
  session: {
    sessionId?: string;
    token?: string;
    expiresAt: string;
  };
  isNewUser?: boolean;
}

export interface OtpDispatch {
  message: string;
  messageId?: string;
  cooldownSeconds?: number;
}

const TOKEN_KEY = 'relay_session_token';

export function getSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setSessionToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearSessionToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function hasSessionToken(): boolean {
  return getSessionToken() !== null;
}

export async function getAuthProviders(): Promise<AuthProviderMetadata[]> {
  const res = await apiClient<ApiResponse<{ providers: AuthProviderMetadata[] }>>(
    '/api/auth/providers'
  );
  return res.data.providers;
}

export function getGoogleAuthUrl(): string {
  return `${API_BASE_URL}/api/auth/google`;
}

export async function exchangeOAuthGrant(code: string): Promise<SessionInfo> {
  const res = await apiClient<ApiResponse<SessionInfo>>('/api/auth/oauth/exchange', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  return res.data;
}

export async function requestEmailOtp(email: string): Promise<OtpDispatch> {
  const res = await apiClient<ApiResponse<OtpDispatch>>('/api/auth/email/request-otp', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  return res.data;
}

export async function verifyEmailOtp(email: string, otpCode: string): Promise<SessionInfo> {
  const res = await apiClient<ApiResponse<SessionInfo>>('/api/auth/email/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ email, otpCode }),
  });
  return res.data;
}

export async function requestPhoneOtp(phone: string): Promise<OtpDispatch> {
  const res = await apiClient<ApiResponse<OtpDispatch>>('/api/auth/phone/request-otp', {
    method: 'POST',
    body: JSON.stringify({ phone }),
  });
  return res.data;
}

export async function verifyPhoneOtp(phone: string, otpCode: string): Promise<SessionInfo> {
  const res = await apiClient<ApiResponse<SessionInfo>>('/api/auth/phone/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ phone, otpCode }),
  });
  return res.data;
}

export async function getSession(): Promise<SessionInfo> {
  const res = await apiClient<ApiResponse<SessionInfo>>('/api/auth/session');
  return res.data;
}

export async function logout(): Promise<void> {
  try {
    await apiClient<ApiResponse<{ message: string }>>('/api/auth/logout', { method: 'POST' });
  } finally {
    if (typeof window !== 'undefined') {
      clearSessionToken();
    }
  }
}
