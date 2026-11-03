import { z } from 'zod';

/**
 * Server-side input validation schemas for Phase 12 identity & onboarding.
 * Never trust client-side validation.
 */

export const EmailSchema = z
  .string()
  .trim()
  .email('Invalid email address')
  .max(150, 'Email too long');

export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[1-9]\d{7,14}$/, 'Invalid phone number format (expected E.164 or 8-15 digits)');

export const CoordinateLatitudeSchema = z
  .number()
  .min(-90, 'Latitude must be between -90 and 90')
  .max(90, 'Latitude must be between -90 and 90');

export const CoordinateLongitudeSchema = z
  .number()
  .min(-180, 'Longitude must be between -180 and 180')
  .max(180, 'Longitude must be between -180 and 180');

export const PostalCodeSchema = z
  .string()
  .trim()
  .min(3, 'Postal code must have at least 3 characters')
  .max(20, 'Postal code too long')
  .regex(/^[A-Za-z0-9\s-]+$/, 'Invalid postal code format');

export const CreateProfileInputSchema = z.object({
  fullName: z.string().trim().min(2, 'Name must be at least 2 characters').max(100, 'Name too long'),
  email: EmailSchema,
  phone: PhoneSchema.optional(),
  profilePhoto: z.string().url('Invalid photo URL').optional(),
  preferredContactMethod: z.enum(['EMAIL', 'SMS', 'WHATSAPP']).default('EMAIL'),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postalCode: PostalCodeSchema.optional(),
  latitude: CoordinateLatitudeSchema.optional(),
  longitude: CoordinateLongitudeSchema.optional(),
});

export const UpdateProfileInputSchema = CreateProfileInputSchema.partial();

export const CreateAddressInputSchema = z.object({
  addressLine: z.string().trim().min(5, 'Address line must be at least 5 characters').max(250),
  city: z.string().trim().min(2, 'City must be at least 2 characters').max(100),
  state: z.string().trim().min(2, 'State must be at least 2 characters').max(100),
  postalCode: PostalCodeSchema,
  country: z.string().trim().min(2, 'Country must be at least 2 characters').max(100).default('India'),
  latitude: CoordinateLatitudeSchema,
  longitude: CoordinateLongitudeSchema,
  isDefault: z.boolean().default(false),
});

export const CreateSocietyInputSchema = z.object({
  name: z.string().trim().min(3, 'Society name must be at least 3 characters').max(150),
  address: z.string().trim().min(5, 'Address must be at least 5 characters').max(250),
  city: z.string().trim().min(2, 'City must be at least 2 characters').max(100),
  state: z.string().trim().min(2, 'State must be at least 2 characters').max(100),
  postalCode: PostalCodeSchema,
  country: z.string().trim().min(2).max(100).default('India'),
  latitude: CoordinateLatitudeSchema,
  longitude: CoordinateLongitudeSchema,
});

export const SocietySearchQuerySchema = z.object({
  query: z.string().trim().max(100).optional(),
  city: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
  latitude: CoordinateLatitudeSchema.optional(),
  longitude: CoordinateLongitudeSchema.optional(),
  radiusKm: z.number().positive().max(100).default(15),
  limit: z.number().int().positive().max(50).default(20),
});

export const CreateMembershipInputSchema = z.object({
  societyId: z.string().trim().min(1, 'Society ID is required'),
  tower: z.string().trim().max(50).optional(),
  flatNumber: z.string().trim().min(1, 'Flat number is required').max(50),
  verificationMethod: z
    .enum(['DOCUMENT_PROOF', 'ADMIN_APPROVAL', 'COMMUNITY_INVITE', 'INSTANT_PRE_VERIFIED'])
    .default('DOCUMENT_PROOF'),
});

export const PaymentMandateOnboardingInputSchema = z.object({
  spendingLimit: z
    .number()
    .positive('Spending limit must be greater than 0')
    .max(1000000, 'Spending limit exceeds maximum allowable ceiling of ₹1,000,000'),
  currency: z.string().trim().length(3, 'Currency must be 3-letter ISO code').default('INR'),
  purpose: z
    .enum(['COMMUNITY_PROCUREMENT', 'EMERGENCY_REPAIR', 'MAINTENANCE', 'UTILITY'])
    .default('COMMUNITY_PROCUREMENT'),
});

export const LoginRequestSchema = z.object({
  provider: z.enum(['GOOGLE', 'EMAIL_PHONE', 'EMAIL', 'PHONE']),
  providerAccountId: z.string().trim().max(200).optional(),
  email: EmailSchema.optional(),
  phone: PhoneSchema.optional(),
  idToken: z.string().trim().optional(),
  authToken: z.string().trim().optional(),
  otpCode: z.string().trim().max(10).optional(),
  name: z.string().trim().max(150).optional(),
  profileImage: z.string().url().optional(),
});

export const RequestEmailOtpSchema = z.object({
  email: EmailSchema,
});

export const VerifyEmailOtpSchema = z.object({
  email: EmailSchema,
  otpCode: z.string().trim().min(4).max(10),
});

export const RequestPhoneOtpSchema = z.object({
  phone: PhoneSchema,
});

export const VerifyPhoneOtpSchema = z.object({
  phone: PhoneSchema,
  otpCode: z.string().trim().min(4).max(10),
});

export const OAuthCallbackQuerySchema = z.object({
  code: z.string().trim().min(1, 'Authorization code is required'),
  state: z.string().trim().min(1, 'OAuth state is required'),
});
