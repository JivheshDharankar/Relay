import { SmsDispatchResult, SmsProvider } from './types';

export interface TwilioConfig {
  accountSid?: string;
  authToken?: string;
  fromPhone?: string;
  fetchFn?: typeof fetch;
}

export class TwilioSmsProvider implements SmsProvider {
  public readonly providerName = 'twilio';
  private readonly accountSid?: string;
  private readonly authToken?: string;
  private readonly fromPhone?: string;
  private readonly fetchFn: typeof fetch;

  constructor(config?: TwilioConfig) {
    this.accountSid = config?.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
    this.authToken = config?.authToken ?? process.env.TWILIO_AUTH_TOKEN;
    this.fromPhone = config?.fromPhone ?? process.env.TWILIO_PHONE_NUMBER;
    this.fetchFn = config?.fetchFn ?? globalThis.fetch;
  }

  public get isConfigured(): boolean {
    return Boolean(
      this.accountSid &&
      this.authToken &&
      this.fromPhone &&
      this.accountSid.trim().length > 0 &&
      this.authToken.trim().length > 0 &&
      this.fromPhone.trim().length > 0
    );
  }

  public async sendSms(to: string, body: string): Promise<SmsDispatchResult> {
    if (!this.isConfigured) {
      return {
        success: false,
        messageId: '',
        providerName: this.providerName,
        errorCode: 'TWILIO_UNCONFIGURED',
        errorMessage:
          'Twilio SMS provider is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.',
      };
    }

    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
      const basicAuth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

      const params = new URLSearchParams();
      params.append('To', to);
      params.append('From', this.fromPhone!);
      params.append('Body', body);

      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          messageId: '',
          providerName: this.providerName,
          errorCode: 'TWILIO_DISPATCH_FAILED',
          errorMessage: `Twilio API returned status ${response.status}: ${errorText}`,
        };
      }

      const json = (await response.json()) as { sid?: string };
      return {
        success: true,
        messageId: json.sid || `tw_${Date.now()}`,
        providerName: this.providerName,
      };
    } catch (err: any) {
      return {
        success: false,
        messageId: '',
        providerName: this.providerName,
        errorCode: 'TWILIO_NETWORK_ERROR',
        errorMessage: err.message || 'Network error communicating with Twilio API',
      };
    }
  }
}

