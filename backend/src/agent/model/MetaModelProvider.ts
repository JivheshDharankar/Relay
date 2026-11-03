import { ModelProvider, ModelProviderError } from './ModelProvider';
import { toWireMessages } from './openaiWireFormat';
import { ModelRequest, ToolModelRequest, ModelResponse, ToolCall } from './types';
import { env } from '../../config/env';

export interface MetaModelProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchFn?: typeof fetch;
}

export interface MetaConfigStatus {
  configured: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  code: 'META_CONFIGURED' | 'META_API_KEY_MISSING' | 'META_MODEL_MISSING';
  reason: string;
}

export type MetaConnectivityStatus = 'not_configured' | 'success' | 'error';

export interface MetaConnectivityResult {
  status: MetaConnectivityStatus;
  detail: string;
}

/**
 * Fixed, non-sensitive prompt used ONLY for the Phase 14.1 connectivity probe.
 * Never carries resident, supplier, payment, or procurement data.
 */
export const META_CONNECTIVITY_PROMPT = 'Return exactly the word READY.';

/**
 * Probe completion budget. Muse Spark 1.3 always reasons and hidden reasoning
 * tokens count against the completion budget; at default effort the model can
 * spend the entire budget reasoning and stop with finish_reason=length and
 * content=null. The probe therefore pairs minimal reasoning effort with a
 * 256-token floor so the one-word answer is always emitted.
 */
export const META_CONNECTIVITY_MAX_TOKENS = 256;

const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ERROR_BODY_CHARS = 2000;

interface OpenAIChatChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string;
}

interface OpenAIChatResponse {
  choices?: OpenAIChatChoice[];
}

/**
 * Phase 14.1 — Meta Model API provider (Muse Spark) behind the existing
 * ModelProvider abstraction. OpenAI-compatible chat-completions client.
 *
 * Inference only: this provider never executes Relay tools, never touches
 * payments, procurement state, or the database. Relay remains the source of
 * truth; the model only reasons.
 */
export class MetaModelProvider implements ModelProvider {
  public readonly providerName = 'meta-spark';
  protected readonly apiKey?: string;
  protected readonly modelName: string;
  protected readonly baseUrl: string;
  protected readonly timeoutMs: number;
  protected readonly maxResponseBytes: number;
  protected readonly fetchFn: typeof fetch;

  constructor(options?: MetaModelProviderOptions) {
    this.apiKey = options?.apiKey ?? env.META_MODEL_API_KEY;
    this.modelName = options?.model ?? env.META_MODEL_NAME;
    this.baseUrl = options?.baseUrl ?? env.META_MODEL_BASE_URL;
    this.timeoutMs = options?.timeoutMs ?? env.META_MODEL_TIMEOUT_MS;
    this.maxResponseBytes = options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.fetchFn = options?.fetchFn ?? fetch;
  }

  /**
   * Secret-safe configuration report. Never includes the API key.
   */
  public getConfigStatus(): MetaConfigStatus {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      return {
        configured: false,
        provider: this.providerName,
        model: this.modelName,
        baseUrl: this.baseUrl,
        code: 'META_API_KEY_MISSING',
        reason:
          'Meta Model API key is not configured. Set META_MODEL_API_KEY to enable live Meta inferences.',
      };
    }
    if (!this.modelName || this.modelName.trim().length === 0) {
      return {
        configured: false,
        provider: this.providerName,
        model: '',
        baseUrl: this.baseUrl,
        code: 'META_MODEL_MISSING',
        reason:
          'Meta model is not configured. Set META_MODEL_NAME (e.g. muse-spark-1.3).',
      };
    }
    return {
      configured: true,
      provider: this.providerName,
      model: this.modelName,
      baseUrl: this.baseUrl,
      code: 'META_CONFIGURED',
      reason: 'Meta Model provider is configured.',
    };
  }

  public isConfigured(): boolean {
    return this.getConfigStatus().configured;
  }

  private checkConfiguration(): void {
    const status = this.getConfigStatus();
    if (!status.configured) {
      throw new ModelProviderError(status.code, status.reason);
    }
  }

  /**
   * Redacts any accidental occurrence of the API key from error text.
   * Defense-in-depth: keys must never appear in errors or logs.
   */
  private redact(text: string): string {
    if (this.apiKey && this.apiKey.length > 0 && text.includes(this.apiKey)) {
      return text.split(this.apiKey).join('[REDACTED]');
    }
    return text;
  }

  private classifyTransportError(err: unknown): ModelProviderError {
    if (err instanceof ModelProviderError) return err;
    const name = err instanceof Error ? err.name : '';
    const message = err instanceof Error ? err.message : String(err);
    if (name === 'AbortError') {
      return new ModelProviderError(
        'META_TIMEOUT',
        `Meta Model API request timed out after ${this.timeoutMs}ms.`
      );
    }
    return new ModelProviderError(
      'META_NETWORK_ERROR',
      this.redact(`Failed to reach Meta Model API at ${this.baseUrl}: ${message}`)
    );
  }

  private async classifyHttpError(response: Response): Promise<ModelProviderError> {
    let body = '';
    try {
      body = await response.text();
    } catch {
      body = '';
    }
    const bounded =
      body.length > MAX_ERROR_BODY_CHARS
        ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}…(truncated)`
        : body;
    const detail = bounded.length > 0 ? `: ${bounded}` : '';
    if (response.status === 401 || response.status === 403) {
      return new ModelProviderError(
        'META_AUTH_ERROR',
        this.redact(`Meta Model API authentication failed (HTTP ${response.status})${detail}`)
      );
    }
    if (response.status === 429) {
      return new ModelProviderError(
        'META_RATE_LIMITED',
        this.redact(`Meta Model API rate limit exceeded (HTTP 429)${detail}`)
      );
    }
    if (response.status >= 500) {
      return new ModelProviderError(
        'META_SERVER_ERROR',
        this.redact(`Meta Model API server error (HTTP ${response.status})${detail}`)
      );
    }
    return new ModelProviderError(
      'META_API_ERROR',
      this.redact(`Meta Model API returned HTTP ${response.status}${detail}`)
    );
  }

  private async parseJsonBody(response: Response): Promise<OpenAIChatResponse> {
    const contentLength = response.headers?.get?.('content-length');
    if (contentLength && Number(contentLength) > this.maxResponseBytes) {
      throw new ModelProviderError(
        'META_RESPONSE_TOO_LARGE',
        `Meta Model API response exceeded ${this.maxResponseBytes} bytes.`
      );
    }
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw new ModelProviderError(
        'META_MALFORMED_RESPONSE',
        this.redact(
          `Meta Model API response body could not be read: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }
    if (text.length > this.maxResponseBytes) {
      throw new ModelProviderError(
        'META_RESPONSE_TOO_LARGE',
        `Meta Model API response exceeded ${this.maxResponseBytes} bytes.`
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new ModelProviderError(
        'META_MALFORMED_RESPONSE',
        this.redact(
          `Meta Model API returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }
    const choices = (data as OpenAIChatResponse)?.choices;
    if (!Array.isArray(choices) || choices.length === 0 || typeof choices[0] !== 'object') {
      throw new ModelProviderError(
        'META_MALFORMED_RESPONSE',
        'Meta Model API response is missing choices[0].'
      );
    }
    return data as OpenAIChatResponse;
  }

  private async postChatCompletions(
    payload: Record<string, unknown>
  ): Promise<OpenAIChatResponse> {
    this.checkConfiguration();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ model: this.modelName, ...payload }),
          signal: controller.signal,
        });
      } catch (err) {
        throw this.classifyTransportError(err);
      }
      if (!response.ok) {
        throw await this.classifyHttpError(response);
      }
      return await this.parseJsonBody(response);
    } finally {
      clearTimeout(timer);
    }
  }

  private static mapFinishReason(reason: unknown): ModelResponse['finishReason'] {
    if (reason === 'tool_calls') return 'tool_calls';
    if (reason === 'length') return 'length';
    return 'stop';
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    const data = await this.postChatCompletions({
      messages: toWireMessages(request.messages),
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? 1024,
      ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    });
    const choice = (data.choices as OpenAIChatChoice[])[0];
    return {
      content: choice?.message?.content ?? '',
      finishReason: MetaModelProvider.mapFinishReason(choice?.finish_reason),
      raw: data,
    };
  }

  public async generateWithTools(request: ToolModelRequest): Promise<ModelResponse> {
    const formattedTools = request.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    const data = await this.postChatCompletions({
      messages: toWireMessages(request.messages),
      tools: formattedTools,
      tool_choice: 'auto',
      temperature: request.temperature ?? 0.1,
      max_tokens: request.maxTokens ?? 2048,
      ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    });
    const choice = (data.choices as OpenAIChatChoice[])[0];
    const message = choice?.message;
    let toolCalls: ToolCall[] | undefined;
    if (message?.tool_calls) {
      toolCalls = message.tool_calls.map((tc, index) => {
        let args: Record<string, unknown> = {};
        if (tc.function?.arguments) {
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            throw new ModelProviderError(
              'META_MALFORMED_RESPONSE',
              `Meta Model API returned invalid tool-call arguments JSON at index ${index}.`
            );
          }
        }
        return {
          id: tc.id ?? `call_meta_${index}`,
          name: tc.function?.name ?? '',
          arguments: args,
        };
      });
    }
    return {
      content: message?.content ?? '',
      toolCalls,
      finishReason: MetaModelProvider.mapFinishReason(choice?.finish_reason),
      raw: data,
    };
  }

  /**
   * Phase 14.1 connectivity probe: exactly ONE trivial, non-sensitive
   * inference. Distinguishes not_configured / success / error.
   */
  public async probeConnectivity(): Promise<MetaConnectivityResult> {
    const status = this.getConfigStatus();
    if (!status.configured) {
      return { status: 'not_configured', detail: `${status.code}: ${status.reason}` };
    }
    try {
      const response = await this.generate({
        messages: [{ role: 'user', content: META_CONNECTIVITY_PROMPT }],
        temperature: 0,
        maxTokens: META_CONNECTIVITY_MAX_TOKENS,
        reasoningEffort: 'minimal',
      });
      const preview = response.content.trim().slice(0, 64);
      return {
        status: 'success',
        detail: `Meta Model API reachable (model=${this.modelName}); response: ${preview}`,
      };
    } catch (err) {
      const code = err instanceof ModelProviderError ? err.code : 'META_UNKNOWN_ERROR';
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'error', detail: this.redact(`${code}: ${message}`).slice(0, 512) };
    }
  }
}
