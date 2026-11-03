import React, { ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'success';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', isLoading = false, disabled, children, ...props }, ref) => {
    const baseStyles =
      'inline-flex items-center justify-center font-semibold transition-colors select-none disabled:opacity-50 disabled:pointer-events-none rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-relay-primary-500 focus-visible:ring-offset-2';

    const variants = {
      primary:
        'bg-relay-primary-600 text-white border-transparent hover:bg-relay-primary-700',
      secondary:
        'bg-relay-navy-900 text-white border-transparent hover:bg-relay-navy-800',
      outline:
        'bg-white text-relay-ink-900 border-relay-surface-border hover:border-relay-navy-200 hover:bg-relay-navy-50',
      ghost:
        'bg-transparent text-relay-ink-700 border-transparent hover:bg-relay-navy-50 hover:text-relay-ink-900',
      success:
        'bg-relay-success-600 text-white border-transparent hover:bg-relay-success-700',
    };

    const sizes = {
      sm: 'text-xs px-3 py-1.5 gap-1.5 min-h-[34px]',
      md: 'text-sm px-4 py-2.5 gap-2 min-h-[42px]',
      lg: 'text-[15px] px-6 py-3 gap-2.5 min-h-[48px]',
    };

    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={cn(baseStyles, variants[variant], sizes[size], className)}
        {...props}
      >
        {isLoading && (
          <svg
            className="animate-spin -ml-0.5 h-4 w-4 text-current"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
