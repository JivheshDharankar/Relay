import { describe, expect, it } from 'vitest';
import { asRecord, bool, findToolResult, num, str, toolErrorMessage } from '@/lib/workflow/guards';

describe('guards', () => {
  it('asRecord accepts plain objects only', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(null)).toBeNull();
    expect(asRecord([1])).toBeNull();
    expect(asRecord('x')).toBeNull();
  });

  it('str/num/bool narrow safely', () => {
    expect(str('a')).toBe('a');
    expect(str('')).toBeNull();
    expect(str(1)).toBeNull();
    expect(num(2)).toBe(2);
    expect(num(NaN)).toBeNull();
    // Backend Decimal strings coerce; garbage does not.
    expect(num('2')).toBe(2);
    expect(num('abc')).toBeNull();
    expect(bool(true)).toBe(true);
    expect(bool(0)).toBeNull();
  });

  it('findToolResult returns the first matching record result', () => {
    const res = {
      steps: [
        { toolCall: { name: 'a', result: { ok: true } } },
        { toolCall: { name: 'b', result: 'nope' } },
      ],
    } as never;
    expect(findToolResult(res, 'a')).toEqual({ ok: true });
    expect(findToolResult(res, 'b')).toBeNull();
    expect(findToolResult(res, 'missing')).toBeNull();
    expect(findToolResult(null, 'a')).toBeNull();
  });

  it('toolErrorMessage surfaces backend failure text', () => {
    const res = {
      steps: [{ toolCall: { name: 'a', error: { code: 'E', message: 'denied' } } }],
    } as never;
    expect(toolErrorMessage(res, 'a')).toBe('denied');
    expect(toolErrorMessage(res, 'missing')).toBeNull();
  });
});
