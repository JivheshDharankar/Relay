import { PaymentExecutionRequest, PaymentProviderResult } from '../types';

/**
 * Provider-agnostic payment gateway abstraction.
 * All concrete providers (Mock, Sandbox, or future real gateways) implement this interface.
 */
export interface PaymentProvider {
  readonly providerName: string;
  readonly isSimulated: boolean;

  /**
   * Executes payment authorization and capture for a validated, privacy-sanitized payment request.
   * NEVER receives raw resident PII, AI prompts, or arbitrary amounts.
   */
  authorizeAndCapture(
    request: PaymentExecutionRequest
  ): Promise<PaymentProviderResult>;
}

