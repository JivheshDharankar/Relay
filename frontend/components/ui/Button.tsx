import React, { ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'success' | 'destructive' | 'link';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', isLoading = false, disabled, children, ...props }, ref) => {
    const baseStyles =
      'inline-flex items-center justify-center font-semibold transition-colors select-none disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B9BFF] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0D12]';

    const variants = {
      primary:
        'bg-relay-gradient text-white border border-transparent rounded-full hover:opacity-90 active:opacity-95 shadow-[0_4px_16px_-6px_rgba(8,102,255,0.55)]',
      secondary:
        'bg-[#1A1F28] text-[#E8EAED] border border-[#262C37] rounded-xl hover:bg-[#212836] hover:border-[#2E3644]',
      outline:
        'bg-transparent text-[#E8EAED] border border-[#262C37] rounded-xl hover:border-[#2E3644] hover:bg-[#1A1F28]',
      ghost:
        'bg-transparent text-[#9AA3B2] border border-transparent rounded-xl hover:bg-[#1A1F28] hover:text-[#E8EAED]',
      success:
        'bg-[#2FBF71] text-[#06130B] border border-transparent rounded-full hover:opacity-90',
      destructive:
        'bg-[#F05252] text-white border border-transparent rounded-xl hover:opacity-90',
      link:
        'bg-transparent text-[#5B9BFF] border border-transparent rounded-lg hover:underline underline-offset-4 px-1',
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
        className={cn(baseStyles, variants[variant], variant !== 'link' && sizes[size], className)}
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
