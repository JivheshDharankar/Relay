'use client';

import React, { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * Copyable reference chip: copies the exact identifier (run/order/mandate
 * reference) to the clipboard. Reports the real outcome — transient
 * "Copied" only after a successful write; clipboard failures are silent
 * (the value stays selectable on screen).
 */
export function CopyRef({
  value,
  className = '',
  dark = false,
}: {
  value: string;
  className?: string;
  dark?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        if (typeof navigator === 'undefined' || !navigator.clipboard) return;
        navigator.clipboard
          .writeText(value)
          .then(() => setCopied(true))
          .catch(() => {});
      }}
      aria-label={copied ? 'Copied' : `Copy reference ${value}`}
      title={copied ? 'Copied' : 'Copy reference'}
      className={`inline-flex items-center gap-1.5 font-mono text-xs rounded px-1.5 py-1 min-h-[28px] transition-colors ${
        dark
          ? 'text-relay-navy-100 hover:bg-white/10 hover:text-white'
          : 'text-relay-ink-500 hover:bg-relay-surface-sunken hover:text-relay-ink-900'
      } ${className}`}
    >
      <span className="break-all text-left">{value}</span>
      {copied ? (
        <Check className="h-3.5 w-3.5 text-relay-success-600 shrink-0" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
      )}
    </button>
  );
}
