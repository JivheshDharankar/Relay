import { SmsDispatchResult, SmsProvider } from './types';
import { TwilioSmsProvider } from './TwilioSmsProvider';
import { MockSmsProvider } from './MockSmsProvider';

export class SmsService {
  private twilioProvider: TwilioSmsProvider;
  private mockProvider: MockSmsProvider;

  constructor(twilio?: TwilioSmsProvider, mock?: MockSmsProvider) {
    this.twilioProvider = twilio ?? new TwilioSmsProvider();
    this.mockProvider = mock ?? new MockSmsProvider();
  }

  public get activeProvider(): SmsProvider {
    if (this.twilioProvider.isConfigured) {
      return this.twilioProvider;
    }
    return this.mockProvider;
  }

  public get isLive(): boolean {
    return this.twilioProvider.isConfigured;
  }

  /**
   * Dispatches an OTP verification code via SMS.
   * Invariant: Never logs the raw OTP code to server console or audit logs.
   */
  public async sendOtp(phone: string, otpCode: string): Promise<SmsDispatchResult> {
    const body = `Your Relay verification code is: ${otpCode}. Valid for 5 minutes. Do not share this code.`;
    const provider = this.activeProvider;
    return provider.sendSms(phone, body);
  }

  public getMockProvider(): MockSmsProvider {
    return this.mockProvider;
  }
}

export const smsService = new SmsService();

