export interface SmsDispatchResult {
  success: boolean;
  messageId: string;
  providerName: string;
  simulated?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface SmsProvider {
  readonly providerName: string;
  readonly isConfigured: boolean;
  sendSms(to: string, body: string): Promise<SmsDispatchResult>;
}

