import React from 'react';
import Link from 'next/link';
import { Container, Button, Card, CardContent } from '@/components/ui';
import { ArrowLeft, Compass } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="flex-1 flex items-center justify-center py-20">
      <Container size="sm">
        <Card className="border-relay-surface-border bg-white">
          <CardContent className="p-8 text-center flex flex-col items-center">
            <div className="h-10 w-10 rounded-full bg-relay-navy-50 text-relay-ink-700 flex items-center justify-center mb-4">
              <Compass className="h-5 w-5" aria-hidden />
            </div>
            <h2 className="text-base font-semibold text-relay-ink-900">Page not found</h2>
            <p className="text-xs text-relay-ink-500 mt-2 max-w-sm">
              This page doesn&apos;t exist. Head back to the command center.
            </p>
            <div className="mt-6">
              <Link href="/">
                <Button variant="outline" size="sm" className="gap-2">
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                  Command center
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </Container>
    </div>
  );
}
