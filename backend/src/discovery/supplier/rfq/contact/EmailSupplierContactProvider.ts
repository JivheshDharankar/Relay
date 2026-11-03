import { env } from '../../../../config/env';
import { generateRFQEmailContent } from '../template';
import {
  NegotiationDispatchRequest,
  NegotiationDispatchResponse,
  ResendProviderConfig,
  RFQDispatchRequest,
  RFQDispatchResponse,
  SupplierContactProvider,
} from './types';
import { SupplierContactError } from './SupplierContactProvider';

/**
 * Production implementation of SupplierContactProvider transmitting RFQs via Resend's REST API.
 * Server-side only; never exposes API key or leaks resident PII.
 */
export class EmailSupplierContactProvider implements SupplierContactProvider {
  public readonly providerName = 'resend';
  private readonly apiKey: string | undefined;
  private readonly fromEmail: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config?: ResendProviderConfig) {
    this.apiKey = config?.apiKey ?? env.RESEND_API_KEY;
    this.fromEmail =
      config?.fromEmail ??
      env.RESEND_FROM_EMAIL ??
      'Relay Procurement <procurement@relaycommunity.com>';
    this.baseUrl = (config?.baseUrl ?? 'https://api.resend.com').replace(/\/$/, '');
    this.timeoutMs = config?.timeoutMs ?? 10000;
    this.fetchFn = config?.fetchFn ?? globalThis.fetch;
  }

  public async sendRFQ(request: RFQDispatchRequest): Promise<RFQDispatchResponse> {
    // 1. Validate API Key
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new SupplierContactError(
        'MISSING_API_KEY',
        'Resend API key is required but not configured. Set RESEND_API_KEY in the environment.'
      );
    }

    // 2. Validate Sender Configuration
    if (!this.fromEmail || this.fromEmail.trim().length === 0) {
      throw new SupplierContactError(
        'INVALID_SENDER',
        'RESEND_FROM_EMAIL sender address is not configured'
      );
    }

    // 3. Resolve Destination Email
    const recipient =
      request.rfq.recipientContact?.trim() || request.rfq.candidate.email?.trim();

    if (!recipient || recipient.length === 0) {
      throw new SupplierContactError(
        'MISSING_RECIPIENT',
        `No destination email address found for supplier candidate '${request.rfq.supplierName}'`
      );
    }

    // 4. Generate Professional, Privacy-Safe Email Content
    const emailContent = generateRFQEmailContent(request.rfq);

    // 5. Execute HTTP Request via Resend API
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: [recipient],
          subject: emailContent.subject,
          html: emailContent.html,
          text: emailContent.text,
          headers: {
            'X-Relay-RFQ-ID': request.rfq.id,
            'X-Entity-Ref-ID': request.idempotencyKey,
          },
        }),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (
        (err instanceof Error && err.name === 'AbortError') ||
        controller.signal.aborted
      ) {
        throw new SupplierContactError(
          'REQUEST_TIMEOUT',
          `Resend API request timed out after ${this.timeoutMs}ms`
        );
      }
      throw new SupplierContactError(
        'PROVIDER_ERROR',
        `Network error communicating with Resend: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        err
      );
    } finally {
      clearTimeout(timer);
    }

    // 6. Handle HTTP Status Codes
    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text().catch(() => null);
      }

      if (response.status === 401 || response.status === 403) {
        throw new SupplierContactError(
          'AUTH_ERROR',
          `Resend authentication failed (HTTP ${response.status}). Verify RESEND_API_KEY.`,
          response.status,
          errorBody
        );
      }

      if (response.status === 429) {
        throw new SupplierContactError(
          'RATE_LIMIT_EXCEEDED',
          'Resend API rate limit exceeded (HTTP 429)',
          429,
          errorBody
        );
      }

      throw new SupplierContactError(
        'PROVIDER_ERROR',
        `Resend API returned HTTP ${response.status}: ${response.statusText}`,
        response.status,
        errorBody
      );
    }

    // 7. Parse Response
    let parsed: any;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new SupplierContactError(
        'MALFORMED_RESPONSE',
        'Resend returned invalid JSON response',
        response.status,
        err
      );
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.id) {
      throw new SupplierContactError(
        'MALFORMED_RESPONSE',
        'Resend response missing required message id',
        response.status,
        parsed
      );
    }

    return {
      success: true,
      messageId: String(parsed.id),
      dispatchedAt: new Date(),
      providerName: this.providerName,
      recipient,
      metadata: { resendId: parsed.id },
    };
  }

  public async sendNegotiation(
    request: NegotiationDispatchRequest
  ): Promise<NegotiationDispatchResponse> {
    // 1. Validate API Key
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new SupplierContactError(
        'MISSING_API_KEY',
        'Resend API key is required but not configured. Set RESEND_API_KEY in the environment.'
      );
    }

    // 2. Validate Sender Configuration
    if (!this.fromEmail || this.fromEmail.trim().length === 0) {
      throw new SupplierContactError(
        'INVALID_SENDER',
        'RESEND_FROM_EMAIL sender address is not configured'
      );
    }

    // 3. Resolve Destination Email
    const recipient = request.recipientEmail?.trim();
    if (!recipient || recipient.length === 0) {
      throw new SupplierContactError(
        'MISSING_RECIPIENT',
        `No destination email address found for supplier '${request.supplierName}'`
      );
    }

    // 4. Execute HTTP Request via Resend API
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: [recipient],
          subject: `[Relay Procurement] Commercial Negotiation Proposal - RFQ #${request.rfqId}`,
          text: request.formattedMessage,
          headers: {
            'X-Relay-Negotiation-ID': request.negotiationId,
            'X-Relay-Proposal-ID': request.proposalId,
            'X-Entity-Ref-ID': request.idempotencyKey,
          },
        }),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (
        (err instanceof Error && err.name === 'AbortError') ||
        controller.signal.aborted
      ) {
        throw new SupplierContactError(
          'REQUEST_TIMEOUT',
          `Resend API request timed out after ${this.timeoutMs}ms`
        );
      }
      throw new SupplierContactError(
        'PROVIDER_ERROR',
        `Network error communicating with Resend: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        err
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text().catch(() => null);
      }

      if (response.status === 401 || response.status === 403) {
        throw new SupplierContactError(
          'AUTH_ERROR',
          `Resend authentication failed (HTTP ${response.status}). Verify RESEND_API_KEY.`,
          response.status,
          errorBody
        );
      }

      if (response.status === 429) {
        throw new SupplierContactError(
          'RATE_LIMIT_EXCEEDED',
          'Resend API rate limit exceeded (HTTP 429)',
          429,
          errorBody
        );
      }

      throw new SupplierContactError(
        'PROVIDER_ERROR',
        `Resend API returned HTTP ${response.status}: ${response.statusText}`,
        response.status,
        errorBody
      );
    }

    let parsed: any;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new SupplierContactError(
        'MALFORMED_RESPONSE',
        'Resend returned invalid JSON response',
        response.status,
        err
      );
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.id) {
      throw new SupplierContactError(
        'MALFORMED_RESPONSE',
        'Resend response missing required message id',
        response.status,
        parsed
      );
    }

    return {
      success: true,
      messageId: String(parsed.id),
      dispatchedAt: new Date(),
      providerName: this.providerName,
      recipient,
      metadata: { resendId: parsed.id },
    };
  }
}

