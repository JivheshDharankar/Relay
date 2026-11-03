import { describe, it, expect } from 'vitest';
import {
  getModelProvider,
  MetaModelProvider,
  MetaSparkProvider,
  MockModelProvider,
  ModelProviderError,
  META_CONNECTIVITY_PROMPT,
  META_CONNECTIVITY_MAX_TOKENS,
} from '../src/agent/model';
import { SEED_IDS } from '../prisma/seed';

const FAKE_KEY = 'test-fake-meta-key-12345';
const FAKE_MODEL = 'muse-spark-1.3';
const FAKE_BASE = 'https://meta.test/v1';

interface CapturedCall {
  url: string;
  init: Record<string, unknown>;
  body: Record<string, unknown>;
}

function okResponse(payload: unknown, contentLength?: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === 'content-length' ? (contentLength ?? null) : null) },
    text: async () => JSON.stringify(payload),
  };
}

function errResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => body,
  };
}

function makeFetch(
  handler: (url: string, init: Record<string, unknown>) => unknown,
  captured?: CapturedCall[]
): typeof fetch {
  return (async (url: unknown, init: unknown) => {
    const record = {
      url: String(url),
      init: (init ?? {}) as Record<string, unknown>,
      body: JSON.parse(String((init as Record<string, unknown>)?.body ?? '{}')) as Record<string, unknown>,
    };
    captured?.push(record);
    return handler(record.url, record.init);
  }) as unknown as typeof fetch;
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: FAKE_KEY,
    model: FAKE_MODEL,
    baseUrl: FAKE_BASE,
    timeoutMs: 1000,
    ...overrides,
  };
}

describe('Phase 14.1 — MetaModelProvider foundation', () => {
  describe('1. Provider configuration detection', () => {
    it('reports configured when key and model are present', () => {
      const provider = new MetaModelProvider(baseOptions());
      expect(provider.isConfigured()).toBe(true);
      const status = provider.getConfigStatus();
      expect(status).toMatchObject({
        configured: true,
        provider: 'meta-spark',
        model: FAKE_MODEL,
        baseUrl: FAKE_BASE,
        code: 'META_CONFIGURED',
      });
    });

    it('exposes no secret in the configuration report', () => {
      const provider = new MetaModelProvider(baseOptions());
      const status = provider.getConfigStatus();
      expect(status).not.toHaveProperty('apiKey');
      expect(JSON.stringify(status)).not.toContain(FAKE_KEY);
    });
  });

  describe('2. Missing API key', () => {
    it('rejects generate with META_API_KEY_MISSING for empty key', async () => {
      const provider = new MetaModelProvider(baseOptions({ apiKey: '' }));
      expect(provider.isConfigured()).toBe(false);
      await expect(
        provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
      ).rejects.toMatchObject({ code: 'META_API_KEY_MISSING' });
    });

    it('rejects generateWithTools with META_API_KEY_MISSING for blank key', async () => {
      const provider = new MetaModelProvider(baseOptions({ apiKey: '   ' }));
      await expect(
        provider.generateWithTools({ messages: [{ role: 'user', content: 'hi' }], tools: [] })
      ).rejects.toMatchObject({ code: 'META_API_KEY_MISSING' });
    });

    it('MetaSparkProvider keeps the legacy missing-key contract', async () => {
      const meta = new MetaSparkProvider({ apiKey: '' });
      await expect(
        meta.generate({ messages: [{ role: 'user', content: 'Test' }] })
      ).rejects.toMatchObject({ code: 'META_API_KEY_MISSING' });
    });
  });

  describe('3. Missing model configuration', () => {
    it('rejects with META_MODEL_MISSING when model is blank', async () => {
      const provider = new MetaModelProvider(baseOptions({ model: '' }));
      expect(provider.getConfigStatus().code).toBe('META_MODEL_MISSING');
      await expect(
        provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
      ).rejects.toMatchObject({ code: 'META_MODEL_MISSING' });
    });
  });

  describe('4. Successful response parsing (mocked HTTP)', () => {
    it('parses a text completion and sends an OpenAI-compatible request', async () => {
      const captured: CapturedCall[] = [];
      const fetchFn = makeFetch(
        () =>
          okResponse({
            choices: [{ message: { content: 'READY' }, finish_reason: 'stop' }],
          }),
        captured
      );
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });
      const res = await provider.generate({
        messages: [{ role: 'user', content: 'Return exactly the word READY.' }],
      });
      expect(res.content).toBe('READY');
      expect(res.finishReason).toBe('stop');

      expect(captured.length).toBe(1);
      expect(captured[0].url).toBe(`${FAKE_BASE}/chat/completions`);
      expect(captured[0].init.method).toBe('POST');
      const headers = captured[0].init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
      expect(captured[0].body).toMatchObject({ model: FAKE_MODEL });
      expect(captured[0].init.signal).toBeInstanceOf(AbortSignal);
    });

    it('parses tool_calls with JSON arguments', async () => {
      const fetchFn = makeFetch(() =>
        okResponse({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  {
                    id: 'call_1',
                    function: {
                      name: 'createRequest',
                      arguments: JSON.stringify({ quantity: 5, unit: 'LITRE' }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })
      );
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });
      const res = await provider.generateWithTools({
        messages: [{ role: 'user', content: 'order oil' }],
        tools: [
          {
            name: 'createRequest',
            description: 'create',
            parameters: { type: 'object', properties: {} },
          },
        ],
      });
      expect(res.finishReason).toBe('tool_calls');
      expect(res.toolCalls).toEqual([
        { id: 'call_1', name: 'createRequest', arguments: { quantity: 5, unit: 'LITRE' } },
      ]);
    });
  });

  describe('4b. Reasoning effort parameter', () => {
    it('sends reasoning_effort only when explicitly requested', async () => {
      const captured: CapturedCall[] = [];
      const fetchFn = makeFetch(
        () => okResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        captured
      );
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });

      await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });
      expect(captured[0].body).not.toHaveProperty('reasoning_effort');

      await provider.generate({
        messages: [{ role: 'user', content: 'hi' }],
        reasoningEffort: 'low',
      });
      expect(captured[1].body.reasoning_effort).toBe('low');
    });
  });

  describe('5. HTTP error handling', () => {
    it.each([
      [401, 'META_AUTH_ERROR'],
      [403, 'META_AUTH_ERROR'],
      [429, 'META_RATE_LIMITED'],
      [500, 'META_SERVER_ERROR'],
      [503, 'META_SERVER_ERROR'],
      [400, 'META_API_ERROR'],
    ])('maps HTTP %i to %s', async (status, code) => {
      const fetchFn = makeFetch(() => errResponse(status, 'upstream says no'));
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });
      const err = await provider
        .generate({ messages: [{ role: 'user', content: 'hi' }] })
        .catch((e: unknown) => e as ModelProviderError);
      expect(err).toBeInstanceOf(ModelProviderError);
      expect(err.code).toBe(code);
      expect(err.message).toContain(String(status));
    });

    it('classifies transport failures as META_NETWORK_ERROR', async () => {
      const fetchFn = makeFetch(() => {
        throw new Error('socket hang up');
      });
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });
      await expect(
        provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
      ).rejects.toMatchObject({ code: 'META_NETWORK_ERROR' });
    });
  });

  describe('6. Timeout handling', () => {
    it('maps AbortError to META_TIMEOUT', async () => {
      const fetchFn = makeFetch(() => {
        throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
      });
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });
      await expect(
        provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
      ).rejects.toMatchObject({ code: 'META_TIMEOUT' });
    });

    it('aborts a hanging request after timeoutMs', async () => {
      const fetchFn = makeFetch((_url, init) => {
        return new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
          });
        });
      });
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn, timeoutMs: 20 });
      await expect(
        provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
      ).rejects.toMatchObject({ code: 'META_TIMEOUT' });
    });
  });

  describe('7. Malformed model response', () => {
    it('rejects invalid JSON with META_MALFORMED_RESPONSE', async () => {
      const fetchFn = makeFetch(() => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => 'not-json{{{',
      }));
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });
      await expect(
        provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
      ).rejects.toMatchObject({ code: 'META_MALFORMED_RESPONSE' });
    });

    it('rejects a payload missing choices[0]', async () => {
      const fetchFn = makeFetch(() => okResponse({ choices: [] }));
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });
      await expect(
        provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
      ).rejects.toMatchObject({ code: 'META_MALFORMED_RESPONSE' });
    });

    it('rejects invalid tool-call arguments JSON', async () => {
      const fetchFn = makeFetch(() =>
        okResponse({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  { id: 'call_1', function: { name: 'x', arguments: '{bad json' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })
      );
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });
      await expect(
        provider.generateWithTools({ messages: [{ role: 'user', content: 'hi' }], tools: [] })
      ).rejects.toMatchObject({ code: 'META_MALFORMED_RESPONSE' });
    });

    it('rejects oversized responses without reading unbounded bodies', async () => {
      const fetchFn = makeFetch(() => okResponse({ choices: [{ message: { content: 'x' } }] }, '99999999'));
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });
      await expect(
        provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
      ).rejects.toMatchObject({ code: 'META_RESPONSE_TOO_LARGE' });
    });
  });

  describe('8. Secret-safe error logging', () => {
    it('redacts the API key from transport errors', async () => {
      const fetchFn = makeFetch(() => {
        throw new Error(`boom ${FAKE_KEY} leaked by underlying stack`);
      });
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });
      const err = await provider
        .generate({ messages: [{ role: 'user', content: 'hi' }] })
        .catch((e: unknown) => e as ModelProviderError);
      expect(err.message).not.toContain(FAKE_KEY);
      expect(err.message).toContain('[REDACTED]');
    });

    it('redacts the API key from echoed HTTP error bodies', async () => {
      const fetchFn = makeFetch(() => errResponse(400, `bad key ${FAKE_KEY} rejected`));
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });
      const err = await provider
        .generate({ messages: [{ role: 'user', content: 'hi' }] })
        .catch((e: unknown) => e as ModelProviderError);
      expect(err.message).not.toContain(FAKE_KEY);
      expect(err.message).toContain('[REDACTED]');
    });
  });

  describe('9. Provider registration', () => {
    it('registers meta aliases without removing mock', () => {
      expect(getModelProvider('meta-model')).toBeInstanceOf(MetaModelProvider);
      expect(getModelProvider('meta').providerName).toBe('meta-spark');
      expect(getModelProvider('meta-spark')).toBeInstanceOf(MetaSparkProvider);
      expect(getModelProvider('mock')).toBeInstanceOf(MockModelProvider);
      expect(new MetaSparkProvider()).toBeInstanceOf(MetaModelProvider);
    });
  });

  describe('10. MockModelProvider remains functional', () => {
    it('generates deterministic text and tool responses', async () => {
      const mock = new MockModelProvider();
      const text = await mock.generate({ messages: [{ role: 'user', content: 'Hello Relay' }] });
      expect(text.content).toBe('Mock Model Text Response');
      expect(text.finishReason).toBe('stop');

      const tools = await mock.generateWithTools({
        messages: [{ role: 'user', content: 'I need 5L cooking oil' }],
        tools: [],
      });
      expect(tools.toolCalls?.[0].name).toBe('createRequest');
      expect(tools.toolCalls?.[0].arguments).toMatchObject({
        productId: SEED_IDS.products.cookingOil,
      });
      expect(tools.finishReason).toBe('tool_calls');
    });
  });

  describe('11. Connectivity probe classification (mocked)', () => {
    it('reports not_configured without performing HTTP', async () => {
      let calls = 0;
      const fetchFn = makeFetch(() => {
        calls++;
        return okResponse({ choices: [{ message: { content: 'READY' } }] });
      });
      const provider = new MetaModelProvider({ ...baseOptions({ apiKey: '' }), fetchFn });
      const result = await provider.probeConnectivity();
      expect(result.status).toBe('not_configured');
      expect(result.detail).toContain('META_API_KEY_MISSING');
      expect(calls).toBe(0);
    });

    it('reports success and sends exactly one trivial prompt', async () => {
      const captured: CapturedCall[] = [];
      const fetchFn = makeFetch(
        () => okResponse({ choices: [{ message: { content: 'READY' }, finish_reason: 'stop' }] }),
        captured
      );
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });
      const result = await provider.probeConnectivity();
      expect(result.status).toBe('success');
      expect(captured.length).toBe(1);
      const sent = JSON.stringify(captured[0].body);
      expect(sent).toContain(META_CONNECTIVITY_PROMPT);
      expect(captured[0].body.max_tokens).toBe(META_CONNECTIVITY_MAX_TOKENS);
      expect(captured[0].body.reasoning_effort).toBe('minimal');
    });

    it('reports error when the API call fails', async () => {
      const fetchFn = makeFetch(() => errResponse(500, 'down'));
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });
      const result = await provider.probeConnectivity();
      expect(result.status).toBe('error');
      expect(result.detail).toContain('META_SERVER_ERROR');
    });

    it('honestly reports a reasoning-truncated response (content null, finish length)', async () => {
      // Observed live shape when the completion budget is exhausted by hidden
      // reasoning: finish_reason=length with content=null. The provider must
      // surface this truthfully, never synthesize text.
      const fetchFn = makeFetch(() =>
        okResponse({
          id: 'chatcmpl-test-truncated',
          object: 'chat.completion',
          model: FAKE_MODEL,
          choices: [
            {
              index: 0,
              finish_reason: 'length',
              logprobs: null,
              message: { role: 'assistant', content: null, refusal: null },
            },
          ],
          usage: {
            completion_tokens: 16,
            prompt_tokens: 15,
            total_tokens: 31,
            completion_tokens_details: { reasoning_tokens: 14 },
          },
        })
      );
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });
      const parsed = await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });
      expect(parsed.content).toBe('');
      expect(parsed.finishReason).toBe('length');

      const result = await provider.probeConnectivity();
      expect(result.status).toBe('success');
      expect(result.detail).not.toContain('READY');
    });

    it('extracts READY from the real reasoning-model success shape', async () => {
      // Live shape with sufficient budget: plain-string content plus extra
      // usage/reasoning fields the parser must tolerate and ignore.
      const fetchFn = makeFetch(() =>
        okResponse({
          id: 'chatcmpl-test-ready',
          object: 'chat.completion',
          model: FAKE_MODEL,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'READY', refusal: null },
            },
          ],
          usage: {
            completion_tokens: 15,
            prompt_tokens: 15,
            total_tokens: 30,
            completion_tokens_details: { reasoning_tokens: 14 },
          },
        })
      );
      const provider = new MetaModelProvider({ ...baseOptions(), fetchFn });
      const result = await provider.probeConnectivity();
      expect(result.status).toBe('success');
      expect(result.detail).toContain('READY');
    });
  });

  describe('12. Live Meta connectivity (config-gated)', () => {
    const LIVE_ENABLED = process.env.META_LIVE_TEST === '1';
    it.skipIf(!LIVE_ENABLED)(
      'performs ONE real Meta Model API call expecting READY',
      async () => {
        const provider = new MetaModelProvider({ timeoutMs: 15000 });
        if (!provider.isConfigured()) {
          throw new Error(
            'META_LIVE_TEST=1 but META_MODEL_API_KEY is not configured; cannot run live test.'
          );
        }
        const result = await provider.probeConnectivity();
        expect(result.status).toBe('success');
        expect(result.detail).toContain('READY');
      },
      25000
    );
  });
});
