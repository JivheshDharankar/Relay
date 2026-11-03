import { randomUUID } from 'crypto';
import { env } from '../../../config/env';

export interface EmailDispatchResult {
  success: boolean;
  messageId: string;
  providerName: string;
  simulated?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface EmailServiceConfig {
  apiKey?: string;
  fromEmail?: string;
  fetchFn?: typeof fetch;
}

export class EmailService {
  private readonly apiKey?: string;
  private readonly fromEmail: string;
  private readonly fetchFn: typeof fetch;

  public mockSentEmails: Array<{ to: string; subject: string; timestamp: Date; messageId: string }> = [];

  constructor(config?: EmailServiceConfig) {
    this.apiKey = config && 'apiKey' in config ? config.apiKey : env.RESEND_API_KEY;
    this.fromEmail =
      (config && 'fromEmail' in config ? config.fromEmail : env.RESEND_FROM_EMAIL) ??
      'Relay Authentication <auth@relaycommunity.com>';
    this.fetchFn = config?.fetchFn ?? globalThis.fetch;
  }

  public get isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  /**
   * Dispatches an OTP verification code via Resend or simulated test carrier.
   * Invariant: Never logs the raw OTP code.
   */
  public async sendOtpEmail(to: string, otpCode: string): Promise<EmailDispatchResult> {
    const subject = 'Your Relay Verification Code';

    if (this.isConfigured) {
      try {
        const response = await this.fetchFn('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: this.fromEmail,
            to: [to],
            subject,
            html: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
                <h2 style="color: #0f172a; margin-top: 0;">Relay Verification Code</h2>
                <p style="color: #334155; font-size: 14px;">Use the verification code below to securely sign in to Relay:</p>
                <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; padding: 16px; background-color: #f1f5f9; text-align: center; border-radius: 6px; margin: 20px 0; color: #0f172a;">
                  ${otpCode}
                </div>
                <p style="color: #64748b; font-size: 13px; line-height: 1.5;">This code will expire in 5 minutes. If you did not request this authentication code, please disregard this email.</p>
              </div>
            `,
            text: `Your Relay verification code is: ${otpCode}. Valid for 5 minutes. Do not share this code.`,
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          return {
            success: false,
            messageId: '',
            providerName: 'resend',
            errorCode: 'RESEND_DISPATCH_FAILED',
            errorMessage: `Resend API returned status ${response.status}: ${errText}`,
          };
        }

        const data = (await response.json()) as { id?: string };
        return {
          success: true,
          messageId: data.id || `resend_${randomUUID().slice(0, 8)}`,
          providerName: 'resend',
        };
      } catch (err: any) {
        return {
          success: false,
          messageId: '',
          providerName: 'resend',
          errorCode: 'RESEND_NETWORK_ERROR',
          errorMessage: err.message || 'Network error communicating with Resend API',
        };
      }
    }

    // Unconfigured / Test mode: record mock dispatch without leaking OTP in logs
    const messageId = `mock_email_${randomUUID().slice(0, 8)}`;
    this.mockSentEmails.push({
      to,
      subject,
      timestamp: new Date(),
      messageId,
    });

    return {
      success: true,
      messageId,
      providerName: 'mock',
      simulated: true,
    };
  }

  public clear(): void {
    this.mockSentEmails = [];
  }
}

export const emailService = new EmailService();

