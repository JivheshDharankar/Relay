'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import { Container } from '@/components/ui';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { AuthRequiredState, ErrorState, LoadingState } from '@/components/feedback/Feedback';
import { useSession } from '@/lib/session/SessionContext';
import { useResidentContext } from '@/lib/session/useResidentContext';
import { getSupplierDeliveryView } from '@/lib/api';

export default function PrivacyPage() {
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const resident = useResidentContext();
  const [supplierView, setSupplierView] = useState<Record<string, unknown> | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);

  useEffect(() => {
    if (!resident.profile?.societyId) return;
    let cancelled = false;
    getSupplierDeliveryView(resident.profile.societyId)
      .then((data) => {
        if (!cancelled) {
          setSupplierView(data);
          setViewError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setViewError(err instanceof Error ? err.message : 'Failed to load supplier view');
      });
    return () => {
      cancelled = true;
    };
  }, [resident.profile?.societyId]);

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-4xl mx-auto">
          <Link
            href="/community"
            className="inline-flex items-center gap-1.5 text-[13px] text-relay-ink-600 hover:text-relay-ink-900 font-medium min-h-[32px]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Community
          </Link>

          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-relay-primary-600">
              Community · Privacy
            </p>
            <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-relay-ink-900 mt-1 flex items-center gap-2">
              <Lock className="h-6 w-6 text-relay-ink-900" aria-hidden />
              Privacy model
            </h1>
            <p className="text-sm text-relay-ink-600 mt-1.5 max-w-2xl leading-relaxed">
              Community procurement does not mean exposing private resident orders.
              Here is exactly what each party can see.
            </p>
          </div>

          {sessionStatus === 'loading' && <LoadingState title="Loading privacy model" />}
          {sessionStatus === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}

          {sessionStatus === 'authenticated' && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card className="border-relay-success-100">
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Eye className="h-4 w-4 text-relay-success-600" aria-hidden />
                      Suppliers see
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <ul className="text-sm text-relay-ink-700 space-y-1.5 leading-relaxed">
                      <li>· Anonymous consolidated batch quantities</li>
                      <li>· Community delivery point (below, live from backend)</li>
                      <li>· Agreed commercial terms</li>
                    </ul>
                  </CardContent>
                </Card>
                <Card className="border-relay-danger-100">
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-2">
                      <EyeOff className="h-4 w-4 text-relay-danger-600" aria-hidden />
                      Suppliers never see
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <ul className="text-sm text-relay-ink-700 space-y-1.5 leading-relaxed">
                      <li>· Resident identity, flat, or tower</li>
                      <li>· Individual order details or quantities</li>
                      <li>· Payment information or mandates</li>
                    </ul>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-relay-success-600" aria-hidden />
                    Live supplier delivery view
                  </CardTitle>
                  <CardDescription>
                    The exact privacy-safe address the backend exposes to suppliers for{' '}
                    {resident.profile?.societyName ?? 'this society'} — fetched live.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  {resident.loading && <LoadingState title="Loading supplier view" />}
                  {!resident.loading && !resident.profile && (
                    <p className="text-sm text-relay-ink-600">Resident context unavailable.</p>
                  )}
                  {viewError && <ErrorState title="Supplier view unavailable" description={viewError} />}
                  {supplierView && (
                    <pre className="rounded-lg bg-relay-navy-900 text-relay-navy-100 text-xs font-mono p-4 overflow-x-auto leading-relaxed">
                      {JSON.stringify(supplierView, null, 2)}
                    </pre>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Session scoping</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 text-sm text-relay-ink-700 leading-relaxed space-y-2">
                  <p>
                    Resident, order, and mandate reads are scoped to the authenticated
                    session. Cross-resident identifiers are rejected with 403 — the
                    backend never serves another resident&apos;s private data to this
                    session.
                  </p>
                  <p>
                    Per-transaction payment history renders only when the backend
                    attributes it to this resident&apos;s own mandate; otherwise Relay
                    shows the mandate ceiling and keeps history hidden.
                  </p>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
