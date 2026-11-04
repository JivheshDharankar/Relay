'use client';

import React, { useEffect } from 'react';
import { Container, Button, Card, CardContent } from '@/components/ui';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('Relay Application Error:', error);
  }, [error]);

  return (
    <div className="flex-1 flex items-center justify-center py-20">
      <Container size="sm">
        <Card className="border-relay-danger-100 bg-[#12161D]">
          <CardContent className="p-8 text-center flex flex-col items-center">
            <div className="h-10 w-10 rounded-full bg-relay-danger-50 text-relay-danger-600 flex items-center justify-center mb-4">
              <AlertTriangle className="h-5 w-5" aria-hidden />
            </div>
            <h2 className="text-base font-semibold text-relay-ink-900">Something went wrong</h2>
            <p className="text-xs text-relay-ink-600 mt-2 max-w-md">
              {error.message || 'An unexpected error occurred while rendering this page.'}
            </p>
            <div className="mt-6">
              <Button variant="outline" size="sm" onClick={() => reset()} className="gap-2">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                Try again
              </Button>
            </div>
          </CardContent>
        </Card>
      </Container>
    </div>
  );
}
