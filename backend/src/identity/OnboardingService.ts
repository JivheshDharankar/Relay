import { OnboardingStatus, OnboardingStateSummary } from './types';
import { userService, UserService } from './UserService';
import { profileService, ProfileService } from './ProfileService';
import { addressService, AddressService } from './AddressService';
import { membershipService, MembershipService } from './MembershipService';
import { mandateService, MandateService } from '../payment/mandate/MandateService';
import { PaymentMandateOnboardingInputSchema } from './validation';
import { AppError } from '../domain/errors';

export class OnboardingService {
  constructor(
    private readonly userSvc: UserService = userService,
    private readonly profileSvc: ProfileService = profileService,
    private readonly addressSvc: AddressService = addressService,
    private readonly membershipSvc: MembershipService = membershipService,
    private readonly mandateSvc: MandateService = mandateService
  ) {}

  /**
   * Evaluates the current authoritative onboarding state for a user.
   * Guarantees resumability: if interrupted at any step, returns the exact next
   * pending step without forcing the user to repeat completed steps.
   */
  public async evaluateOnboardingState(userId: string): Promise<OnboardingStateSummary> {
    const user = await this.userSvc.getUserById(userId);
    if (!user) {
      throw new Error(`User '${userId}' not found`);
    }

    const profile = await this.profileSvc.getProfile(userId);
    const addresses = await this.addressSvc.getAddresses(userId);
    const membership = await this.membershipSvc.getMembershipByUserId(userId);

    const residentId = await this.userSvc.getResidentIdForUser(userId);
    const activeMandates = this.mandateSvc
      .listMandates()
      .filter((m) => m.ownerReference === residentId && m.status === 'ACTIVE');

    const hasProfile = Boolean(profile);
    const hasAddress = addresses.length > 0;
    const hasSociety = Boolean(membership);
    const hasMembership = Boolean(membership && membership.verificationStatus === 'VERIFIED');
    const hasPaymentMandate = activeMandates.length > 0;

    let currentStep: OnboardingStatus = 'ONBOARDING_COMPLETE';

    if (!hasProfile) {
      currentStep = 'PROFILE_REQUIRED';
    } else if (!hasAddress) {
      currentStep = 'ADDRESS_REQUIRED';
    } else if (!hasSociety) {
      currentStep = 'SOCIETY_REQUIRED';
    } else if (!hasMembership) {
      currentStep = 'SOCIETY_VERIFICATION_REQUIRED';
    } else if (!hasPaymentMandate) {
      currentStep = 'PAYMENT_AUTHORIZATION_REQUIRED';
    } else {
      currentStep = 'ONBOARDING_COMPLETE';
    }

    // Synchronize status to User identity record
    if (user.onboardingStatus !== currentStep) {
      await this.userSvc.updateUser(userId, { onboardingStatus: currentStep });
    }

    return {
      userId,
      currentStep,
      isComplete: currentStep === 'ONBOARDING_COMPLETE',
      hasProfile,
      hasAddress,
      hasSociety,
      hasMembership,
      hasPaymentMandate,
      residentId,
      updatedAt: new Date(),
    };
  }

  /**
   * Step 1: Complete Profile
   */
  public async submitProfileStep(userId: string, rawInput: unknown): Promise<OnboardingStateSummary> {
    const state = await this.evaluateOnboardingState(userId);
    if (state.currentStep !== 'AUTHENTICATED' && state.currentStep !== 'PROFILE_REQUIRED') {
      // If profile already exists, allow updating it without breaking sequence
      if (!state.hasProfile) {
        throw new Error(`Invalid onboarding transition: Expected PROFILE_REQUIRED but was ${state.currentStep}`);
      }
    }

    await this.profileSvc.createProfile(userId, rawInput);
    return this.evaluateOnboardingState(userId);
  }

  /**
   * Step 2: Complete Address
   */
  public async submitAddressStep(userId: string, rawInput: unknown): Promise<OnboardingStateSummary> {
    const state = await this.evaluateOnboardingState(userId);
    if (!state.hasProfile) {
      throw new Error('Invalid onboarding transition: Profile must be completed before adding home address');
    }

    await this.addressSvc.addAddress(userId, rawInput);
    return this.evaluateOnboardingState(userId);
  }

  /**
   * Step 3: Select Society & Submit Membership (Tower + Flat)
   */
  public async submitSocietyStep(userId: string, rawInput: unknown): Promise<OnboardingStateSummary> {
    const state = await this.evaluateOnboardingState(userId);
    if (!state.hasAddress) {
      throw new Error('Invalid onboarding transition: Address must be added before selecting a society');
    }

    await this.membershipSvc.createMembership(userId, rawInput);
    return this.evaluateOnboardingState(userId);
  }

  /**
   * Step 4: Verify Society Membership via explicit residence attestation.
   *
   * Relay has no external verifier (admin/document/invite backend), so this
   * step records the user's explicit self-attestation of residence. It
   * requires an affirmative attestation payload, is idempotent, and every
   * verification is audit-logged by the controller. Callers must treat the
   * resulting membership as self-attested, not independently verified.
   */
  public async verifySocietyStep(
    userId: string,
    attestation?: { attestResidence?: unknown }
  ): Promise<OnboardingStateSummary> {
    if (!attestation || attestation.attestResidence !== true) {
      throw new AppError(
        'Explicit residence attestation is required to verify society membership',
        400,
        'ATTESTATION_REQUIRED'
      );
    }

    const membership = await this.membershipSvc.getMembershipByUserId(userId);
    if (!membership) {
      throw new AppError('No society membership found to verify', 422, 'MEMBERSHIP_REQUIRED');
    }

    if (membership.verificationStatus !== 'VERIFIED') {
      await this.membershipSvc.updateVerificationStatus(membership.id, 'VERIFIED');
    }
    return this.evaluateOnboardingState(userId);
  }

  /**
   * Step 5: Establish Authorized Relay Procurement Mandate (Phase 7 Integration)
   */
  public async submitPaymentMandateStep(
    userId: string,
    rawInput: unknown
  ): Promise<OnboardingStateSummary> {
    const state = await this.evaluateOnboardingState(userId);
    if (!state.hasMembership) {
      throw new AppError(
        'Invalid onboarding transition: Society membership must be verified before establishing payment mandate',
        422,
        'ONBOARDING_TRANSITION_INVALID'
      );
    }

    const validated = PaymentMandateOnboardingInputSchema.parse(rawInput);
    const residentId = await this.userSvc.getResidentIdForUser(userId);

    // Call authoritative Phase 7 MandateService directly (no duplicate limit system)
    this.mandateSvc.createMandate({
      ownerReference: residentId,
      purpose: validated.purpose,
      currency: validated.currency,
      spendingLimit: validated.spendingLimit,
      metadata: {
        createdVia: 'ONBOARDING_FLOW',
        userId,
      },
    });

    return this.evaluateOnboardingState(userId);
  }
}

export const onboardingService = new OnboardingService();

