import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  toWireMessages,
  MetaModelProvider,
  MetaSparkProvider,
  SparkOpenProvider,
  ModelProviderError,
} from '../src/agent/model';
import type { ModelMessage } from '../src/agent/model';

const FAKE_KEY = 'test-fake-meta-key-12345';
const FAKE_MODEL = 'muse-spark-1.3';
const FAKE_BASE = 'https://meta.test/v1';

function okResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

function captureFetch(handler: (body: Record<string, unknown>) => unknown) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_url: unknown, init: unknown) => {
    const body = JSON.parse(
      String((init as Record<string, unknown>)?.body ?? '{}')
    ) as Record<string, unknown>;
    bodies.push(body);
    return handler(body);
  }) as unknown as typeof fetch;
  return { bodies, fetchFn };
}

function stopPayload(content = 'done') {
  return { choices: [{ message: { content }, finish_reason: 'stop' }] };
}

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
  return out;
}

describe('Phase 18.1 — OpenAI wire serialization boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('1. Plain messages pass through unchanged', () => {
    it('serializes system/user/assistant messages to identical role+content pairs', () => {
      const input: ModelMessage[] = [
        { role: 'system', content: 'policy' },
        { role: 'user', content: 'I need 3 kg sugar.' },
        { role: 'assistant', content: 'on it' },
      ];
      expect(toWireMessages(input)).toEqual([
        { role: 'system', content: 'policy' },
        { role: 'user', content: 'I need 3 kg sugar.' },
        { role: 'assistant', content: 'on it' },
      ]);
    });

    it('does not mutate its input', () => {
      const toolMsg: ModelMessage = {
        role: 'tool',
        name: 'createRequest',
        content: '{"ok":true}',
        toolCallId: 'call_1',
      };
      const input: ModelMessage[] = [toolMsg];
      toWireMessages(input);
      expect(input[0]).toEqual({
        role: 'tool',
        name: 'createRequest',
        content: '{"ok":true}',
        toolCallId: 'call_1',
      });
    });
  });

  describe('2. Assistant tool calls serialize to tool_calls', () => {
    it('converts one tool call with JSON-stringified arguments', () => {
      const wire = toWireMessages([
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_abc', name: 'createRequest', arguments: { quantity: 3, unit: 'KG' } },
          ],
        },
      ]);
      expect(wire).toEqual([
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_abc',
              type: 'function',
              function: {
                name: 'createRequest',
                arguments: JSON.stringify({ quantity: 3, unit: 'KG' }),
              },
            },
          ],
        },
      ]);
    });

    it('preserves order, ids, and arguments across multiple tool calls', () => {
      const wire = toWireMessages([
        {
          role: 'assistant',
          content: 'two calls',
          toolCalls: [
            { id: 'call_1', name: 'first', arguments: { a: 1 } },
            { id: 'call_2', name: 'second', arguments: { b: 'x', nested: { c: [1, 2] } } },
          ],
        },
      ]);
      const calls = (wire[0] as Record<string, unknown>).tool_calls as Array<
        Record<string, unknown>
      >;
      expect(calls).toHaveLength(2);
      expect(calls[0].id).toBe('call_1');
      expect(calls[1].id).toBe('call_2');
      expect(JSON.parse(String((calls[1].function as Record<string, unknown>).arguments))).toEqual(
        { b: 'x', nested: { c: [1, 2] } }
      );
    });
  });

  describe('3. Tool results serialize to tool_call_id', () => {
    it('emits role/content/tool_call_id and strips the internal name field', () => {
      const wire = toWireMessages([
        {
          role: 'tool',
          name: 'createRequest',
          content: '{"success":true}',
          toolCallId: 'call_abc',
        },
      ]);
      expect(wire).toEqual([
        { role: 'tool', content: '{"success":true}', tool_call_id: 'call_abc' },
      ]);
    });
  });

  describe('4. No camelCase tool fields leak onto the wire', () => {
    it('round-trips a full multi-round history without toolCalls/toolCallId keys', () => {
      const history: ModelMessage[] = [
        { role: 'system', content: 'policy' },
        { role: 'user', content: 'I need 3 kg sugar.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'createRequest', arguments: { quantity: 3 } }],
        },
        {
          role: 'tool',
          name: 'createRequest',
          content: '{"success":true}',
          toolCallId: 'call_1',
        },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_2', name: 'discoverSuppliers', arguments: {} }],
        },
        {
          role: 'tool',
          name: 'discoverSuppliers',
          content: '{"success":true}',
          toolCallId: 'call_2',
        },
      ];
      const wire = toWireMessages(history);
      const keys = collectKeys(wire);
      expect(keys).not.toContain('toolCalls');
      expect(keys).not.toContain('toolCallId');
      expect(keys).toContain('tool_calls');
      expect(keys).toContain('tool_call_id');
      // Every tool result references a real assistant call id.
      const callIds = new Set(
        wire
          .flatMap((m) => ((m.tool_calls as Array<Record<string, unknown>>) ?? []).map((c) => c.id))
      );
      for (const m of wire) {
        if (m.role === 'tool') expect(callIds.has(m.tool_call_id)).toBe(true);
      }
    });
  });

  describe('5. Malformed internal messages fail safely', () => {
    it.each([
      ['non-array input', () => toWireMessages('nope' as unknown as ModelMessage[])],
      ['null message', () => toWireMessages([null as unknown as ModelMessage])],
      [
        'unknown role',
        () => toWireMessages([{ role: 'wizard', content: 'x' } as unknown as ModelMessage]),
      ],
      [
        'non-string content',
        () => toWireMessages([{ role: 'user', content: 42 } as unknown as ModelMessage]),
      ],
      [
        'tool result without toolCallId',
        () => toWireMessages([{ role: 'tool', content: '{}' } as unknown as ModelMessage]),
      ],
      [
        'tool result with empty toolCallId',
        () => toWireMessages([{ role: 'tool', content: '{}', toolCallId: '' }]),
      ],
      [
        'non-array toolCalls',
        () =>
          toWireMessages([
            { role: 'assistant', content: '', toolCalls: {} as unknown as [] },
          ]),
      ],
      [
        'tool call without id',
        () =>
          toWireMessages([
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ name: 'x', arguments: {} } as unknown as ModelMessage['toolCalls'] extends Array<infer T> ? T : never],
            },
          ]),
      ],
      [
        'tool call without name',
        () =>
          toWireMessages([
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call_1', arguments: {} } as unknown as ModelMessage['toolCalls'] extends Array<infer T> ? T : never],
            },
          ]),
      ],
    ])('throws INVALID_MODEL_MESSAGE for %s', (_label, invoke) => {
      try {
        invoke();
        expect.unreachable('expected INVALID_MODEL_MESSAGE');
      } catch (err) {
        expect(err).toBeInstanceOf(ModelProviderError);
        expect((err as ModelProviderError).code).toBe('INVALID_MODEL_MESSAGE');
      }
    });

    it('throws INVALID_MODEL_MESSAGE for non-serializable arguments', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() =>
        toWireMessages([
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'x', arguments: circular }],
          },
        ])
      ).toThrowError(ModelProviderError);
    });
  });

  describe('6. Provider payload integration', () => {
    const tools = [
      {
        name: 'createRequest',
        description: 'create',
        parameters: { type: 'object' as const, properties: {} },
      },
    ];

    it('MetaModelProvider.generateWithTools sends wire-format messages', async () => {
      const { bodies, fetchFn } = captureFetch(() => okResponse(stopPayload()));
      const provider = new MetaModelProvider({
        apiKey: FAKE_KEY,
        model: FAKE_MODEL,
        baseUrl: FAKE_BASE,
        timeoutMs: 1000,
        fetchFn,
      });
      await provider.generateWithTools({
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'createRequest', arguments: { q: 3 } }],
          },
          { role: 'tool', name: 'createRequest', content: '{"ok":true}', toolCallId: 'call_1' },
        ],
        tools,
      });
      expect(bodies).toHaveLength(1);
      const messages = bodies[0].messages as Array<Record<string, unknown>>;
      expect(messages[1].tool_calls).toEqual([
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'createRequest', arguments: '{"q":3}' },
        },
      ]);
      expect(messages[2]).toEqual({
        role: 'tool',
        content: '{"ok":true}',
        tool_call_id: 'call_1',
      });
      expect(collectKeys(bodies[0])).not.toContain('toolCalls');
      expect(collectKeys(bodies[0])).not.toContain('toolCallId');
    });

    it('MetaModelProvider.generate leaves single-shot messages byte-identical', async () => {
      const { bodies, fetchFn } = captureFetch(() => okResponse(stopPayload('READY')));
      const provider = new MetaModelProvider({
        apiKey: FAKE_KEY,
        model: FAKE_MODEL,
        baseUrl: FAKE_BASE,
        timeoutMs: 1000,
        fetchFn,
      });
      const input: ModelMessage[] = [
        { role: 'system', content: 'policy' },
        { role: 'user', content: 'Return exactly the word READY.' },
      ];
      const response = await provider.generate({ messages: input });
      expect(response.content).toBe('READY');
      expect(bodies[0].messages).toEqual(input);
    });

    it('MetaSparkProvider inherits the wire serialization', async () => {
      const { bodies, fetchFn } = captureFetch(() => okResponse(stopPayload()));
      const provider = new MetaSparkProvider({
        apiKey: FAKE_KEY,
        model: FAKE_MODEL,
        baseUrl: FAKE_BASE,
        timeoutMs: 1000,
        fetchFn,
      });
      await provider.generateWithTools({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'tool', name: 't', content: '{}', toolCallId: 'call_9' },
        ],
        tools,
      });
      const messages = bodies[0].messages as Array<Record<string, unknown>>;
      expect(messages[1]).toEqual({ role: 'tool', content: '{}', tool_call_id: 'call_9' });
    });

    it('SparkOpenProvider sends wire-format messages', async () => {
      const { bodies, fetchFn } = captureFetch(() => okResponse(stopPayload()));
      vi.stubGlobal('fetch', fetchFn);
      const provider = new SparkOpenProvider();
      await provider.generateWithTools({
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_7', name: 't', arguments: {} }],
          },
          { role: 'tool', name: 't', content: '{}', toolCallId: 'call_7' },
        ],
        tools,
      });
      const messages = bodies[0].messages as Array<Record<string, unknown>>;
      expect(messages[0].tool_calls).toEqual([
        { id: 'call_7', type: 'function', function: { name: 't', arguments: '{}' } },
      ]);
      expect(messages[1]).toEqual({ role: 'tool', content: '{}', tool_call_id: 'call_7' });
    });

    it('malformed history fails before any HTTP call', async () => {
      const { bodies, fetchFn } = captureFetch(() => okResponse(stopPayload()));
      const provider = new MetaModelProvider({
        apiKey: FAKE_KEY,
        model: FAKE_MODEL,
        baseUrl: FAKE_BASE,
        timeoutMs: 1000,
        fetchFn,
      });
      await expect(
        provider.generateWithTools({
          messages: [{ role: 'tool', content: '{}' } as unknown as ModelMessage],
          tools,
        })
      ).rejects.toMatchObject({ code: 'INVALID_MODEL_MESSAGE' });
      expect(bodies).toHaveLength(0);
    });
  });
});
