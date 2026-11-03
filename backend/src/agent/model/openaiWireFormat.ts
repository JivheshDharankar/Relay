import { ModelProviderError } from './ModelProvider';
import { ModelMessage, ToolCall } from './types';

/**
 * Phase 18.1 — shared OpenAI-compatible wire serializer.
 *
 * Internal Relay messages use camelCase (`toolCalls`, `toolCallId`) and may
 * carry internal-only fields (`name` on tool results). The OpenAI-compatible
 * chat-completions wire format requires snake_case (`tool_calls`,
 * `tool_call_id`) and rejects unknown fields. Every HTTP model provider must
 * route outbound messages through `toWireMessages` so multi-round tool loops
 * never 400 on the second request.
 *
 * Pure and side-effect free: it never logs, never touches secrets, and never
 * mutates its input. Malformed internal messages throw a classified
 * `ModelProviderError` BEFORE any network call (fail closed).
 */
export function toWireMessages(messages: ModelMessage[]): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) {
    throw new ModelProviderError(
      'INVALID_MODEL_MESSAGE',
      'Cannot serialize model messages: expected an array.'
    );
  }
  return messages.map((message, index) => toWireMessage(message, index));
}

function toWireMessage(message: ModelMessage, index: number): Record<string, unknown> {
  if (!message || typeof message !== 'object') {
    throw new ModelProviderError(
      'INVALID_MODEL_MESSAGE',
      `Cannot serialize model message at index ${index}: expected an object.`
    );
  }
  const { role, content } = message;
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
    throw new ModelProviderError(
      'INVALID_MODEL_MESSAGE',
      `Cannot serialize model message at index ${index}: unknown role.`
    );
  }
  if (typeof content !== 'string') {
    throw new ModelProviderError(
      'INVALID_MODEL_MESSAGE',
      `Cannot serialize model message at index ${index}: content must be a string.`
    );
  }
  if (role === 'system' || role === 'user') {
    return { role, content };
  }
  if (role === 'assistant') {
    const wire: Record<string, unknown> = { role, content };
    if (message.toolCalls !== undefined) {
      if (!Array.isArray(message.toolCalls)) {
        throw new ModelProviderError(
          'INVALID_MODEL_MESSAGE',
          `Cannot serialize model message at index ${index}: toolCalls must be an array.`
        );
      }
      wire.tool_calls = message.toolCalls.map((call, callIndex) =>
        toWireToolCall(call, index, callIndex)
      );
    }
    return wire;
  }
  // role === 'tool': the wire format carries ONLY role/content/tool_call_id.
  // The internal `name` field is deliberately stripped: unknown fields are
  // rejected by OpenAI-compatible endpoints.
  if (typeof message.toolCallId !== 'string' || message.toolCallId.length === 0) {
    throw new ModelProviderError(
      'INVALID_MODEL_MESSAGE',
      `Cannot serialize model message at index ${index}: tool result is missing its toolCallId.`
    );
  }
  return { role, content, tool_call_id: message.toolCallId };
}

function toWireToolCall(
  call: ToolCall,
  messageIndex: number,
  callIndex: number
): Record<string, unknown> {
  if (!call || typeof call !== 'object') {
    throw new ModelProviderError(
      'INVALID_MODEL_MESSAGE',
      `Cannot serialize tool call ${callIndex} at message index ${messageIndex}: expected an object.`
    );
  }
  if (typeof call.id !== 'string' || call.id.length === 0) {
    throw new ModelProviderError(
      'INVALID_MODEL_MESSAGE',
      `Cannot serialize tool call ${callIndex} at message index ${messageIndex}: missing id.`
    );
  }
  if (typeof call.name !== 'string' || call.name.length === 0) {
    throw new ModelProviderError(
      'INVALID_MODEL_MESSAGE',
      `Cannot serialize tool call ${callIndex} at message index ${messageIndex}: missing name.`
    );
  }
  let argsJson: string;
  try {
    argsJson = JSON.stringify(call.arguments ?? {});
  } catch {
    throw new ModelProviderError(
      'INVALID_MODEL_MESSAGE',
      `Cannot serialize tool call ${callIndex} at message index ${messageIndex}: arguments are not JSON-serializable.`
    );
  }
  return {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: argsJson },
  };
}
