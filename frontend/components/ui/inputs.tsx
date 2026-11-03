import React from 'react';
import { cn } from '@/lib/utils';

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-[13px] font-semibold text-relay-ink-900">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-relay-ink-500">{hint}</p>}
      {error && (
        <p className="text-xs text-relay-danger-700 font-medium" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export const inputClassName =
  'w-full rounded-lg border border-relay-surface-border bg-white px-3.5 py-2.5 text-sm text-relay-ink-900 placeholder:text-relay-ink-400 outline-none transition-colors focus:border-relay-primary-500 focus:ring-2 focus:ring-relay-primary-500/20 disabled:opacity-60 disabled:bg-relay-navy-50 min-h-[44px]';

export function TextInput({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputClassName, 'tnum', className)} />;
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cn(inputClassName, className)}>
      {children}
    </select>
  );
}

export function TextArea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(inputClassName, className)} />;
}
