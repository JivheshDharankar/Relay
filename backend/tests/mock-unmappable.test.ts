import { describe, it, expect } from 'vitest';
import { MockModelProvider } from '../src/agent/model/MockModelProvider';
import { RelayAgent } from '../src/agent/relayAgent';
import { SEED_IDS } from '../src/config/seedConstants';
import type { ToolModelRequest } from '../src/agent/model/types';

function userRequest(prompt: string): ToolModelRequest {
  return { messages: [{ role: 'user', content: prompt }], tools: [] };
}

/**
 * P0 data-integrity: an unmappable product must NEVER be substituted with an
 * unrelated catalog product (the icecream → sunflower oil failure). Unknown
 * requests stop honestly with a structured UNMAPPABLE_PRODUCT code.
 */
describe('MockModelProvider unmappable-product honesty', () => {
  it('stops honestly for "I need 2 icecream" — never sunflower oil', async () => {
    const provider = new MockModelProvider();
    const res = await provider.generateWithTools(userRequest('I need 2 icecream'));

    expect(res.finishReason).toBe('stop');
    expect(res.toolCalls).toBeUndefined();
    expect(res.raw).toMatchObject({ code: 'UNMAPPABLE_PRODUCT' });
    // The original command is preserved in the message for the trail.
    expect(res.content).toContain('I need 2 icecream');
    expect(res.content).toContain('need a little more information');
    // The historical substitution must be impossible here: no tool ran, no
    // order exists, no success is claimed, and no product list is emitted.
    expect(res.content).not.toContain('Supported products');
    expect(res.content).not.toContain('has been secured');
    expect(res.content).not.toContain('Initiating procurement request creation');
    expect(JSON.stringify(res)).not.toContain(SEED_IDS.products.cookingOil);
  });

  it('stops honestly for a completely unknown product', async () => {
    const provider = new MockModelProvider();
    const res = await provider.generateWithTools(userRequest('I need 1 flux capacitor urgently'));

    expect(res.finishReason).toBe('stop');
    expect(res.toolCalls).toBeUndefined();
    expect(res.raw).toMatchObject({ code: 'UNMAPPABLE_PRODUCT' });
    expect(res.content).toContain('flux capacitor');
  });

  it('maps the legitimate sunflower request to sunflower oil (no regression)', async () => {
    const provider = new MockModelProvider();
    const res = await provider.generateWithTools(
      userRequest('I need 5 litres sunflower cooking oil'),
    );

    expect(res.finishReason).toBe('tool_calls');
    expect(res.toolCalls?.[0].name).toBe('createRequest');
    expect(res.toolCalls?.[0].arguments).toMatchObject({
      productId: SEED_IDS.products.cookingOil,
      quantity: 5,
      unit: 'LITRE',
    });
  });

  it('maps bamboo toothbrushes to the toothbrush catalog product', async () => {
    const provider = new MockModelProvider();
    const res = await provider.generateWithTools(userRequest('I need 7 bamboo toothbrushes'));

    expect(res.finishReason).toBe('tool_calls');
    expect(res.toolCalls?.[0].arguments).toMatchObject({
      productId: SEED_IDS.products.toothbrushes,
      quantity: 7,
    });
  });

  it('never maps outside the requested items for sugar + groundnut (single-item chain)', async () => {
    const provider = new MockModelProvider();
    const res = await provider.generateWithTools(
      userRequest('I need 2 kg sugar and 1 kg groundnut'),
    );

    // The deterministic mock runs single-item chains: it must procure one of
    // the REQUESTED items — never an unrelated catalog product.
    expect(res.finishReason).toBe('tool_calls');
    const productId = res.toolCalls?.[0].arguments?.productId;
    expect([SEED_IDS.products.sugar, SEED_IDS.products.groundnut]).toContain(productId);
    expect(productId).not.toBe(SEED_IDS.products.cookingOil);
  });

  it('does not leak a previous run intent into a later unmappable command', async () => {
    const provider = new MockModelProvider();
    // First run maps sunflower (sets internal intent state on the shared instance).
    await provider.generateWithTools(userRequest('I need 5 litres sunflower cooking oil'));
    // Second, unrelated run must still stop honestly…
    const blocked = await provider.generateWithTools(userRequest('I need 2 icecream'));
    expect(blocked.finishReason).toBe('stop');
    expect(blocked.raw).toMatchObject({ code: 'UNMAPPABLE_PRODUCT' });
    // …and a stray tool follow-up must fail loud, never reuse stale intent.
    await expect(
      provider.generateWithTools({
        messages: [
          { role: 'user', content: 'I need 2 icecream' },
          { role: 'tool', name: 'aggregateDemand', content: '{}' },
        ],
        tools: [],
      }),
    ).rejects.toThrow(/without a mapped intent/);
  });

  it('derives the final success message from recorded evidence, not a fallback product', async () => {
    const provider = new MockModelProvider();
    // Simulate a completed groundnut chain with NO live activeIntent (fresh
    // instance): the message must come from the recorded createRequest tool
    // outcome — never a hardcoded product.
    const res = await provider.generateWithTools({
      messages: [
        { role: 'user', content: 'I need 2 kg of raw groundnuts' },
        {
          role: 'tool',
          name: 'createRequest',
          content: JSON.stringify({
            success: true,
            productName: 'Raw Premium Groundnut (Peanuts)',
            quantity: 2,
            unit: 'KG',
          }),
        },
        { role: 'tool', name: 'reconcileOrder', content: JSON.stringify({ success: true }) },
      ],
      tools: [],
    });

    expect(res.finishReason).toBe('stop');
    expect(res.content).toContain('Groundnut');
    expect(res.content).not.toContain('Sunflower');
  });

  it('never claims success when recorded tool steps failed', async () => {
    const provider = new MockModelProvider();
    const res = await provider.generateWithTools({
      messages: [
        { role: 'user', content: 'I need 5 litres sunflower cooking oil' },
        {
          role: 'tool',
          name: 'checkAuthorization',
          content: JSON.stringify({
            success: false,
            error: { message: 'MANDATE_LIMIT_EXCEEDED' },
          }),
        },
        { role: 'tool', name: 'reconcileOrder', content: JSON.stringify({ success: true }) },
      ],
      tools: [],
    });

    expect(res.finishReason).toBe('stop');
    expect(res.content).toContain('could not complete');
    expect(res.content).toContain('MANDATE_LIMIT_EXCEEDED');
    expect(res.content).toContain('No order was secured');
    expect(res.content).not.toContain('has been secured through');
  });
});

describe('RelayAgent blocked-run contract', () => {
  // DB-free: the unmappable run stops before any tool executes (audit writes
  // warn-and-continue without a database).
  it('reports success:false + UNMAPPABLE_PRODUCT when the model stops before any tool ran', async () => {
    const agent = new RelayAgent({ modelProvider: new MockModelProvider() });
    const result = await agent.run({
      residentId: 'res_test_unmappable',
      societyId: 'soc_test_unmappable',
      message: 'I need 2 icecream',
    });

    expect(result.success).toBe(false);
    expect(result.completed).toBe(false);
    expect(result.error?.code).toBe('UNMAPPABLE_PRODUCT');
    expect(result.error?.message).toContain('I need 2 icecream');
    expect(result.error?.message).toContain('need a little more information');
    expect(result.totalSteps).toBe(1);
    expect(result.steps.some((s) => Boolean(s.toolCall))).toBe(false);
  });

  it('reports success:false + UNMAPPABLE_PRODUCT for a completely unknown product', async () => {
    const agent = new RelayAgent({ modelProvider: new MockModelProvider() });
    const result = await agent.run({
      residentId: 'res_test_unmappable',
      societyId: 'soc_test_unmappable',
      message: 'I need 1 quantum flux regulator',
    });

    expect(result.success).toBe(false);
    expect(result.completed).toBe(false);
    expect(result.error?.code).toBe('UNMAPPABLE_PRODUCT');
    expect(result.steps.some((s) => Boolean(s.toolCall))).toBe(false);
  });
});
