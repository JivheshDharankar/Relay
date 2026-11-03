/**
 * Display-only formatting helpers.
 *
 * HARD RULE: these functions format backend-provided values for display.
 * They must never compute authoritative money, totals, balances, or
 * reconciliation verdicts. The backend is the source of truth.
 */

/** Formats a backend money value exactly as provided (number or Decimal string). */
export function formatMoney(value: number | string, currency = 'INR'): string {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(numeric)) return `${currency} ${String(value)}`;
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(numeric);
  } catch {
    return `${currency} ${numeric.toFixed(2)}`;
  }
}

/** Compact money for dense surfaces (e.g. "₹8,000"). Still display-only. */
export function formatMoneyCompact(value: number | string, currency = 'INR'): string {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(numeric)) return `${currency} ${String(value)}`;
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${symbol}${numeric.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export function formatQuantity(value: number | string, unit?: string): string {
  const numeric = typeof value === 'string' ? Number(value) : value;
  const text = Number.isFinite(numeric)
    ? numeric.toLocaleString('en-IN', { maximumFractionDigits: 4 })
    : String(value);
  return unit ? `${text} ${unit}` : text;
}

export function formatPercent(value: number | string): string {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(numeric)) return String(value);
  return `${numeric.toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`;
}

/**
 * Human-readable supplier rating (1 decimal). The backend stores
 * reliabilityScore * 5 as a float, which can render float artifacts
 * (e.g. 4.6000000000000005) — display trims, value untouched.
 */
export function formatRating(value: number | string): string {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(numeric)) return String(value);
  return numeric.toLocaleString('en-IN', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Shortens a UUID/reference for display while keeping it identifiable. */
export function shortRef(ref: string | null | undefined, prefix = ''): string {
  if (!ref) return '—';
  const compact = ref.replace(/-/g, '');
  if (compact.length <= 12) return `${prefix}${ref}`;
  return `${prefix}${compact.slice(0, 8).toUpperCase()}`;
}
