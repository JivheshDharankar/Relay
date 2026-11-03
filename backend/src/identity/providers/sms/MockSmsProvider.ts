import { randomUUID } from 'crypto';
import { SmsDispatchResult, SmsProvider } from './types';

export interface SentSmsRecord {
  to: string;
  body: string;
  timestamp: Date;
  messageId: string;
}

export class MockSmsProvider implements SmsProvider {
  public readonly providerName = 'mock';
  public readonly isConfigured = true;
  public sentMessages: SentSmsRecord[] = [];

  public async sendSms(to: string, body: string): Promise<SmsDispatchResult> {
    const messageId = `mock_sms_${randomUUID().slice(0, 8)}`;
    this.sentMessages.push({
      to,
      body,
      timestamp: new Date(),
      messageId,
    });

    return {
      success: true,
      messageId,
      providerName: this.providerName,
      simulated: true,
    };
  }

  public clear(): void {
    this.sentMessages = [];
  }
}

