import React from 'react';
import { Container } from '@/components/ui';

export default function Loading() {
  return (
    <div className="flex-1 flex items-center justify-center py-24">
      <Container size="sm" className="text-center">
        <div className="inline-flex items-center justify-center p-3 rounded-full bg-relay-navy-50 text-relay-primary-600 mb-4 animate-spin">
          <svg className="h-6 w-6" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden>
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        </div>
        <h2 className="text-sm font-semibold text-relay-ink-900">Loading…</h2>
        <p className="text-xs text-relay-ink-500 mt-1">Fetching verified state from the Relay backend</p>
      </Container>
    </div>
  );
}
