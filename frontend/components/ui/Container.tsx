import React, { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface ContainerProps extends HTMLAttributes<HTMLDivElement> {
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
}

export function Container({ className, size = 'xl', ...props }: ContainerProps) {
  const maxSizes = {
    sm: 'max-w-2xl',
    md: 'max-w-4xl',
    lg: 'max-w-5xl',
    xl: 'max-w-6xl',
    full: 'max-w-full',
  };

  return (
    <div className={cn('w-full mx-auto px-4 sm:px-6 lg:px-12', maxSizes[size], className)} {...props} />
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && (
          <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-[#5B9BFF]">
            {eyebrow}
          </p>
        )}
        <h1 className="text-[32px] leading-[40px] font-semibold tracking-tight text-[#E8EAED] mt-2">
          {title}
        </h1>
        {description && (
          <p className="text-[15px] leading-[24px] text-[#9AA3B2] mt-2 max-w-2xl">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

/** Section heading used inside pages (20px / 28px). */
export function SectionTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2 className={cn('text-[20px] leading-[28px] font-semibold tracking-tight text-[#E8EAED]', className)}>
      {children}
    </h2>
  );
}
