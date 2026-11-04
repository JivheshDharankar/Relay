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
      <label htmlFor={htmlFor} className="block text-[13px] font-semibold text-[#E8EAED]">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-[13px] text-[#9AA3B2]">{hint}</p>}
      {error && (
        <p className="text-[13px] text-[#F87171] font-medium" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export const inputClassName =
  'w-full rounded-xl border border-[#262C37] bg-[#0D1117] px-3.5 py-2.5 text-[15px] text-[#E8EAED] placeholder:text-[#8A94A6] outline-none transition-colors focus:border-[#0866FF] focus:ring-2 focus:ring-[#0866FF]/25 disabled:opacity-60 disabled:bg-[#12161D] min-h-[48px]';

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
