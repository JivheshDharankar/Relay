/**
 * Relay Phase 12: Production Hardening + Real User Identity Domain Types
 */

export type AuthProviderType = 'GOOGLE' | 'EMAIL_PHONE' | 'EMAIL' | 'PHONE';

export type ProviderStatus = 'CONFIGURED' | 'UNCONFIGURED' | 'ERROR';

export interface ProviderMetadata {
  id: AuthProviderType;
  name: string;
  type: 'OAUTH' | 'OTP';
  status: ProviderStatus;
  isAvailable: boolean;
  requiresConfig: boolean;
  authorizationUrl?: string;
  errorMessage?: string;
}

export type OnboardingStatus =
  | 'NEW'
  | 'AUTHENTICATED'
  | 'PROFILE_REQUIRED'
  | 'ADDRESS_REQUIRED'
  | 'SOCIETY_REQUIRED'
  | 'SOCIETY_VERIFICATION_REQUIRED'
  | 'PAYMENT_AUTHORIZATION_REQUIRED'
  | 'ONBOARDING_COMPLETE';

export type PreferredContactMethod = 'EMAIL' | 'SMS' | 'WHATSAPP';

export type SocietyVerificationStatus = 'VERIFIED' | 'PENDING_VERIFICATION' | 'REJECTED';

export type MembershipVerificationStatus =
  | 'PENDING_VERIFICATION'
  | 'VERIFIED'
  | 'REJECTED'
  | 'SUSPENDED';

export type MembershipVerificationMethod =
  | 'DOCUMENT_PROOF'
  | 'ADMIN_APPROVAL'
  | 'COMMUNITY_INVITE'
  | 'INSTANT_PRE_VERIFIED';

/**
 * Core persistent User Identity representation.
 */
export interface UserIdentity {
  id: string;
  authProvider: AuthProviderType;
  providerAccountId: string;
  email: string;
  phone?: string;
  name: string;
  profileImage?: string;
  onboardingStatus: OnboardingStatus;
  residentId: string; // Deterministic, unique, stable link to Relay Resident domain
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * User Profile model with contact preferences.
 */
export interface UserProfile {
  userId: string;
  fullName: string;
  email: string;
  phone?: string;
  profilePhoto?: string;
  preferredContactMethod: PreferredContactMethod;
  city?: string;
  state?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Reusable, location-agnostic Address model.
 */
export interface UserAddress {
  id: string;
  userId: string;
  addressLine: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude: number;
  longitude: number;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Dynamic Society model (not a hardcoded dropdown).
 */
export interface Society {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude: number;
  longitude: number;
  verificationStatus: SocietyVerificationStatus;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Society Membership linking an authenticated User to a Society.
 * Flat number and resident personal data are strictly private.
 */
export interface SocietyMembership {
  id: string;
  userId: string;
  societyId: string;
  tower?: string;
  flatNumber: string;
  verificationStatus: MembershipVerificationStatus;
  verificationMethod: MembershipVerificationMethod;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Supplier-sanitized community delivery view.
 * Guarantees zero leakage of flatNumber or resident PII to suppliers!
 */
export interface SupplierCommunityDeliveryView {
  societyId: string;
  societyName: string;
  communityDeliveryAddress: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude: number;
  longitude: number;
}

/**
 * Secure User Session representation.
 */
export interface UserSession {
  sessionId: string;
  userId: string;
  token: string;
  createdAt: Date;
  expiresAt: Date;
  isValid: boolean;
  userAgent?: string;
  ipAddress?: string;
}

/**
 * Credentials passed to AuthProvider.
 */
export interface AuthCredentials {
  provider: AuthProviderType;
  providerAccountId?: string;
  email?: string;
  phone?: string;
  idToken?: string;
  authToken?: string;
  otpCode?: string;
  name?: string;
  profileImage?: string;
}

/**
 * Structured outcome of an authentication attempt.
 */
export interface AuthResult {
  success: boolean;
  user?: UserIdentity;
  session?: UserSession;
  isNewUser?: boolean;
  requiresConfig?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Onboarding progress summary returned to client.
 */
export interface OnboardingStateSummary {
  userId: string;
  currentStep: OnboardingStatus;
  isComplete: boolean;
  hasProfile: boolean;
  hasAddress: boolean;
  hasSociety: boolean;
  hasMembership: boolean;
  hasPaymentMandate: boolean;
  residentId: string;
  updatedAt: Date;
}

