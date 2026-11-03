import { ModelProvider, ModelProviderError } from './ModelProvider';
import { toWireMessages } from './openaiWireFormat';
import { ModelRequest, ToolModelRequest, ModelResponse } from './types';
import { env } from '../../config/env';

export class SparkOpenProvider implements ModelProvider {
  public readonly providerName = 'spark-open';
  private baseUrl: string;
  private modelName: string;
  private timeoutMs: number;

  constructor(options?: { endpoint?: string; model?: string; timeoutMs?: number }) {
    this.baseUrl = options?.endpoint ?? env.SPARK_OPEN_BASE_URL;
    this.modelName = options?.model ?? env.SPARK_OPEN_MODEL_NAME;
    this.timeoutMs = options?.timeoutMs ?? env.SPARK_OPEN_TIMEOUT_MS;
  }

  private async postChat(body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new ModelProviderError(
          'SPARK_OPEN_TIMEOUT',
          `Spark Open request timed out after ${this.timeoutMs}ms`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    try {
      const response = await this.postChat({
        model: this.modelName,
        messages: toWireMessages(request.messages),
        temperature: request.temperature ?? 0.2,
      });

      if (!response.ok) {
        throw new ModelProviderError(
          'SPARK_OPEN_ERROR',
          `Spark Open server returned HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`
        );
      }

      const data = (await response.json()) as any;
      const choice = data.choices?.[0];

      return {
        content: choice?.message?.content || '',
        finishReason: choice?.finish_reason || 'stop',
        raw: data,
      };
    } catch (err) {
      if (err instanceof ModelProviderError) throw err;
      throw new ModelProviderError(
        'SPARK_OPEN_UNAVAILABLE',
        `Spark Open model endpoint at ${this.baseUrl} is unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  public async generateWithTools(request: ToolModelRequest): Promise<ModelResponse> {
    try {
      const formattedTools = request.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));

      const response = await this.postChat({
        model: this.modelName,
        messages: toWireMessages(request.messages),
        tools: formattedTools,
        temperature: request.temperature ?? 0.1,
      });

      if (!response.ok) {
        throw new ModelProviderError(
          'SPARK_OPEN_ERROR',
          `Spark Open server returned HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`
        );
      }

      const data = (await response.json()) as any;
      const choice = data.choices?.[0];
      const message = choice?.message;

      const toolCalls = message?.tool_calls?.map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
      }));

      return {
        content: message?.content || '',
        toolCalls,
        finishReason: choice?.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
        raw: data,
      };
    } catch (err) {
      if (err instanceof ModelProviderError) throw err;
      throw new ModelProviderError(
        'SPARK_OPEN_UNAVAILABLE',
        `Spark Open model endpoint at ${this.baseUrl} is unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

