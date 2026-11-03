import React, { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'navy';
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
    neutral: 'bg-relay-navy-50 text-relay-ink-700 border-relay-surface-border',
    success: 'bg-relay-success-50 text-relay-success-700 border-relay-success-100',
    warning: 'bg-relay-warn-50 text-relay-warn-700 border-relay-warn-100',
    error: 'bg-relay-danger-50 text-relay-danger-700 border-relay-danger-100',
    info: 'bg-relay-primary-50 text-relay-primary-700 border-relay-primary-100',
    navy: 'bg-relay-navy-900 text-white border-transparent',
  };

  const sizes = {
    sm: 'text-[11px] px-2 py-[3px] font-semibold',
    md: 'text-xs px-2.5 py-1 font-semibold',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded border leading-none tabular-nums whitespace-nowrap',
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
