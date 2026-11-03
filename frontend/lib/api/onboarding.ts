import { apiClient } from './client';

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export type OnboardingStep =
  | 'AUTHENTICATED'
  | 'PROFILE_REQUIRED'
  | 'ADDRESS_REQUIRED'
  | 'SOCIETY_REQUIRED'
  | 'SOCIETY_VERIFICATION_REQUIRED'
  | 'PAYMENT_AUTHORIZATION_REQUIRED'
  | 'ONBOARDING_COMPLETE';

export interface OnboardingSummary {
  userId: string;
  currentStep: OnboardingStep;
  isComplete: boolean;
  hasProfile: boolean;
  hasAddress: boolean;
  hasSociety: boolean;
  hasMembership: boolean;
  hasPaymentMandate: boolean;
  residentId: string | null;
  updatedAt: string;
}

export interface ProfileInput {
  fullName: string;
  email: string;
  phone?: string;
  preferredContactMethod?: 'EMAIL' | 'SMS' | 'WHATSAPP';
  city?: string;
  state?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
}

export interface AddressInput {
  addressLine: string;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  latitude: number;
  longitude: number;
  isDefault?: boolean;
}

export interface MembershipInput {
  societyId: string;
  tower?: string;
  flatNumber: string;
  verificationMethod?:
    | 'DOCUMENT_PROOF'
    | 'ADMIN_APPROVAL'
    | 'COMMUNITY_INVITE'
    | 'INSTANT_PRE_VERIFIED';
}

export interface PaymentMandateInput {
  spendingLimit: number;
  currency?: string;
  purpose?: 'COMMUNITY_PROCUREMENT' | 'EMERGENCY_REPAIR' | 'MAINTENANCE' | 'UTILITY';
}

export async function getOnboardingStatus(): Promise<OnboardingSummary> {
  const res = await apiClient<ApiResponse<OnboardingSummary>>('/api/onboarding/status');
  return res.data;
}

export async function submitProfileStep(input: ProfileInput): Promise<OnboardingSummary> {
  const res = await apiClient<ApiResponse<OnboardingSummary>>('/api/onboarding/profile', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return res.data;
}

export async function submitAddressStep(input: AddressInput): Promise<OnboardingSummary> {
  const res = await apiClient<ApiResponse<OnboardingSummary>>('/api/onboarding/address', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return res.data;
}

export async function submitSocietyStep(input: MembershipInput): Promise<OnboardingSummary> {
  const res = await apiClient<ApiResponse<OnboardingSummary>>('/api/onboarding/society', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return res.data;
}

export async function verifySocietyStep(): Promise<OnboardingSummary> {
  const res = await apiClient<ApiResponse<OnboardingSummary>>('/api/onboarding/verify-society', {
    method: 'POST',
    body: JSON.stringify({ attestResidence: true }),
  });
  return res.data;
}

export async function submitPaymentMandateStep(
  input: PaymentMandateInput
): Promise<OnboardingSummary> {
  const res = await apiClient<ApiResponse<OnboardingSummary>>(
    '/api/onboarding/payment-mandate',
    {
      method: 'POST',
      body: JSON.stringify(input),
    }
  );
  return res.data;
}
