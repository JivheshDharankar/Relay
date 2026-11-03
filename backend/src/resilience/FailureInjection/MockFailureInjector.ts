import { PaymentExecutionRequest, PaymentProviderResult } from '../../payment/types';
import { PaymentProvider } from '../../payment/provider/PaymentProvider';
import { MockPaymentProvider } from '../../payment/provider/MockPaymentProvider';
import { failureInjector, FailureInjector } from './FailureInjector';

/**
 * Chaos-injectable Payment Provider.
 * Allows deterministic failure and timeout injection into payment execution paths.
 */
export class ChaosPaymentProvider implements PaymentProvider {
  public readonly providerName = 'ChaosPaymentProvider';
  public readonly isSimulated = true;

  constructor(
    private readonly underlyingProvider: PaymentProvider = new MockPaymentProvider(),
    private readonly injector: FailureInjector = failureInjector
  ) {}

  public async authorizeAndCapture(
    request: PaymentExecutionRequest
  ): Promise<PaymentProviderResult> {
    // Interception point 1: pre-submit check
    await this.injector.maybeThrow('payment_provider');

    // Interception point 2: specific request check
    await this.injector.maybeThrow(`payment_provider:${request.paymentId}`);

    const result = await this.underlyingProvider.authorizeAndCapture(request);

    // Interception point 3: post-submit network loss (bank charged, response dropped)
    await this.injector.maybeThrow('payment_provider:post_submit');

    return result;
  }
}

export const chaosPaymentProvider = new ChaosPaymentProvider();

