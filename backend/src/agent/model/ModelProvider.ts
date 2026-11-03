import { ModelRequest, ToolModelRequest, ModelResponse } from './types';

export class ModelProviderError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ModelProviderError';
    this.code = code;
  }
}

/**
 * Common abstraction for AI model providers powering the Relay Agent (Muse Spark).
 */
export interface ModelProvider {
  readonly providerName: string;

  /**
   * Generates a basic text response.
   */
  generate(request: ModelRequest): Promise<ModelResponse>;

  /**
   * Generates a response with structured tool-calling capabilities.
   */
  generateWithTools(request: ToolModelRequest): Promise<ModelResponse>;
}

