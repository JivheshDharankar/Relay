'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, ShieldCheck, UserRound, Wallet } from 'lucide-react';
import { Container, PageHeader } from '@/components/ui';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { AuthRequiredState, LoadingState } from '@/components/feedback/Feedback';
import { MandateLimitEditor } from '@/components/finance/MandateLimitEditor';
import { useSession } from '@/lib/session/SessionContext';
import { useResidentContext } from '@/lib/session/useResidentContext';
import { formatDateTime } from '@/lib/format';

export default function SettingsPage() {
  const router = useRouter();
  const { status, session, signOut } = useSession();
  const resident = useResidentContext();
  const mandate = resident.mandate;
  const trustedPayments = resident.paymentsTrusted ? resident.payments?.mandate : null;

  const handleSignOut = () => {
    void signOut().then(() => router.push('/login'));
  };

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-3xl mx-auto">
          <PageHeader
            eyebrow="Account"
            title="Settings"
            description="Session, identity, and mandate."
          />

          {status === 'loading' && <LoadingState title="Loading settings" />}
          {status === 'anonymous' && <AuthRequiredState onSignIn={() => router.push('/login')} />}

          {status === 'authenticated' && session && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-1.5">
                    <UserRound className="h-4 w-4 text-relay-ink-500" aria-hidden />
                    Identity
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <dl className="text-sm space-y-2.5">
                    <div className="flex justify-between gap-2">
                      <dt className="text-relay-ink-500">Name</dt>
                      <dd className="font-medium text-right">{session.user.name ?? resident.profile?.name ?? '—'}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-relay-ink-500">Email</dt>
                      <dd className="font-medium text-right break-all">{session.user.email ?? '—'}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-relay-ink-500">Society</dt>
                      <dd className="font-medium text-right">{resident.profile?.societyName ?? '—'}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-relay-ink-500">Flat</dt>
                      <dd className="font-mono text-[13px] text-right">{resident.profile?.flatNumber ?? '—'}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-relay-ink-500">Session expires</dt>
                      <dd className="font-medium text-right">{formatDateTime(session.session.expiresAt)}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-1.5">
                    <Wallet className="h-4 w-4 text-relay-ink-500" aria-hidden />
                    Payment mandate
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  {mandate ? (
                    <MandateLimitEditor
                      mandate={mandate}
                      usedAmount={trustedPayments ? trustedPayments.usedAmount : null}
                      remainingLimit={trustedPayments ? trustedPayments.remainingLimit : null}
                      reload={resident.reload}
                    />
                  ) : (
                    <p className="text-sm text-relay-ink-600">
                      No active mandate.{' '}
                      <button
                        type="button"
                        onClick={() => router.push('/onboarding')}
                        className="font-semibold text-relay-primary-600 hover:underline"
                      >
                        Complete onboarding
                      </button>
                      .
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-1.5">
                    <ShieldCheck className="h-4 w-4 text-relay-ink-500" aria-hidden />
                    Security
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <dl className="text-sm space-y-2.5">
                    <div className="flex justify-between gap-2">
                      <dt className="text-relay-ink-500">Session</dt>
                      <dd className="font-medium text-right">Active</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-relay-ink-500">Expires</dt>
                      <dd className="font-medium text-right">{formatDateTime(session.session.expiresAt)}</dd>
                    </div>
                  </dl>
                  <Button variant="outline" onClick={handleSignOut} className="w-full sm:w-auto mt-4">
                    <LogOut className="h-4 w-4" aria-hidden />
                    Sign out
                  </Button>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
