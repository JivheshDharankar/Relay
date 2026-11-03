import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatMoney,
  formatMoneyCompact,
  formatPercent,
  formatQuantity,
  formatRating,
  shortRef,
} from '@/lib/format';

describe('format (display-only, never authoritative)', () => {
  it('formats INR money from number or Decimal string', () => {
    expect(formatMoney(5000)).toContain('5,000');
    expect(formatMoney('1234.50')).toContain('1,234');
    expect(formatMoneyCompact(10000)).toMatch(/10\s?K|10,000/);
  });

  it('formats quantities and percents', () => {
    expect(formatQuantity(2, 'kg')).toBe('2 kg');
    expect(formatQuantity('3')).toBe('3');
    expect(formatPercent(100)).toContain('100');
  });

  it('trims float-artifact supplier ratings to one decimal', () => {
    expect(formatRating(4.8)).toBe('4.8');
    expect(formatRating(4.6000000000000005)).toBe('4.6');
    expect(formatRating(3.9000000000000004)).toBe('3.9');
    expect(formatRating('4.6')).toBe('4.6');
    expect(formatRating('n/a')).toBe('n/a');
  });

  it('handles missing dates and refs honestly', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
    // Unparseable input passes through verbatim rather than being hidden.
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
    expect(formatDateTime('2026-01-02T03:04:05.000Z')).not.toBe('—');
    expect(shortRef(null)).toBe('—');
    expect(shortRef('abcdef1234567890', 'ORD-')).toContain('ORD-');
  });
});
