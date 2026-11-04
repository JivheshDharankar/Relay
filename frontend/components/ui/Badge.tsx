import React, { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'navy' | 'simulated' | 'danger';
  size?: 'sm' | 'md';
}

export function Badge({
  className,
  variant = 'neutral',
  size = 'md',
  children,
  ...props
}: BadgeProps) {
  const variants = {
    neutral: 'bg-[#1A1F28] text-[#B9C0CC] border-[#262C37]',
    success: 'bg-[#0E2417] text-[#5AD68F] border-[#1D4A30]',
    warning: 'bg-[#241C08] text-[#F7B955] border-[#4A3A12]',
    error: 'bg-[#241010] text-[#F87171] border-[#4A1D1D]',
    danger: 'bg-[#241010] text-[#F87171] border-[#4A1D1D]',
    info: 'bg-[#111E33] text-[#5B9BFF] border-[#1E3A66]',
    navy: 'bg-[#1A1F28] text-[#E8EAED] border-[#2E3644]',
    simulated: 'bg-[#1E1A33] text-[#B9A5FF] border-[#3A2E66]',
  };

  const sizes = {
    sm: 'text-[11px] px-2 py-[3px] font-semibold',
    md: 'text-xs px-2.5 py-1 font-semibold',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border leading-none tabular-nums whitespace-nowrap',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

/** Status pill — label always carries text, never color alone. */
export function StatusPill({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const normalized = status.toUpperCase();
  const variant: BadgeProps['variant'] =
    normalized === 'SIMULATED'
      ? 'simulated'
      : ['COMPLETED', 'VERIFIED', 'RECONCILED', 'ACTIVE', 'DELIVERED', 'PAID', 'SUCCESS', 'PASSED'].includes(normalized)
        ? 'success'
        : ['FAILED', 'ERROR', 'REJECTED', 'CANCELLED'].includes(normalized)
          ? 'error'
          : ['PENDING', 'PROCESSING', 'IN_PROGRESS', 'RUNNING', 'AWAITING'].some((s) => normalized.includes(s))
            ? 'warning'
            : 'info';
  return (
    <Badge variant={variant} className={className}>
      {status}
    </Badge>
  );
}
