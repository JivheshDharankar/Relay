'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, GitCompareArrows, Layers, ShoppingBag, Store, Truck } from 'lucide-react';
import { Container, PageHeader } from '@/components/ui';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { AuthRequiredState, LoadingState } from '@/components/feedback/Feedback';
import { ApiClientError, getOrders, getSuppliers } from '@/lib/api';
import { useSession } from '@/lib/session/SessionContext';
import { useRunStore } from '@/lib/workflow/runStore';
import { getQuoteEvidence } from '@/lib/workflow/runEvidence';

const LIFECYCLE = [
  { step: 'Discovery', text: 'Suppliers near your society are discovered and qualified.', href: '/market' },
  { step: 'Quotes', text: 'Offers are normalized and ranked by the backend.', href: '/quotes' },
  { step: 'Supplier selection', text: 'Relay picks the eligible offer and can show why.', href: '/quotes' },
  { step: 'Orders', text: 'Resident demand is pooled into community orders.', href: '/orders' },
  { step: 'Fulfillment', text: 'Delivery is tracked and verified against evidence.', href: '/tracking' },
];

/**
 * Procurement overview: lifecycle orientation plus live counts from the
 * actual surfaces (orders, supplier directory, latest run's quotes). Every
 * figure is fetched from its source — nothing is duplicated or invented.
 */
export default function ProcurementPage() {
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const { runs, ready: runsReady } = useRunStore();
  const [ordersCount, setOrdersCount] = useState<{ total: number; active: number } | null>(null);
  const [suppliersCount, setSuppliersCount] = useState<number | null>(null);

  useEffect(() => {
    if (sessionStatus !== 'authenticated') return;
    let cancelled = false;
    getOrders()
      .then((list) => {
        if (cancelled) return;
        setOrdersCount({
          total: list.length,
          active: list.filter(
            (o) => o.status !== 'DELIVERED' && o.status !== 'CANCELLED'
          ).length,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
          router.push('/login');
        }
      });
    getSuppliers()
      .then((list) => {
        if (!cancelled) setSuppliersCount(list.length);
      })
      .catch(() => {
        // Directory count is supplementary; links remain.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionStatus, router]);

  const latestRun = runsReady ? (runs[0] ?? null) : null;
  const quotes = latestRun ? getQuoteEvidence(latestRun) : null;

  const surfaces = [
    {
      name: 'Market',
      href: '/market',
      icon: Store,
      description: 'Discovered suppliers and live commercial evidence from autonomous runs.',
      stat: suppliersCount !== null ? `${suppliersCount} verified suppliers` : null,
    },
    {
      name: 'Quotes',
      href: '/quotes',
      icon: GitCompareArrows,
      description: 'Normalized supplier offers across runs — ranked by the backend, inspected here.',
      stat: quotes ? `${quotes.offers.length} offers in latest run` : null,
    },
    {
      name: 'Orders',
      href: '/orders',
      icon: ShoppingBag,
      description: 'Resident and community orders created by executed missions.',
      stat: ordersCount
        ? `${ordersCount.active} active · ${ordersCount.total} total`
        : null,
    },
    {
      name: 'Suppliers',
      href: '/suppliers',
      icon: Layers,
      description: 'Verified supplier directory with qualification evidence.',
      stat: suppliersCount !== null ? `${suppliersCount} in directory` : null,
    },
  ];

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <PageHeader
            eyebrow="Procurement"
            title="Procurement"
            description="Every step from supplier discovery to committed orders — each surface below reads live backend evidence."
          />

          {sessionStatus === 'loading' && <LoadingState title="Loading procurement" />}
          {sessionStatus === 'anonymous' && (
            <AuthRequiredState onSignIn={() => router.push('/login')} />
          )}

          {sessionStatus === 'authenticated' && (
            <>
              {/* Lifecycle orientation */}
              <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-px bg-relay-surface-border border border-relay-surface-border rounded-lg overflow-hidden" aria-label="Procurement lifecycle">
                {LIFECYCLE.map((item, i) => (
                  <li key={item.step} className="bg-white px-4 py-3.5">
                    <p className="font-mono text-[11px] text-relay-teal-600">{String(i + 1).padStart(2, '0')}</p>
                    <p className="text-[13px] font-semibold text-relay-ink-900 mt-1">{item.step}</p>
                    <p className="text-xs text-relay-ink-500 leading-relaxed mt-0.5">{item.text}</p>
                  </li>
                ))}
              </ol>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {surfaces.map((surface) => (
                  <Link key={surface.href} href={surface.href} className="block group">
                    <Card className="h-full hover:border-relay-navy-200 transition-colors">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                          <surface.icon className="h-4 w-4 text-relay-ink-400" aria-hidden />
                          {surface.name}
                        </CardTitle>
                        <CardDescription>{surface.description}</CardDescription>
                      </CardHeader>
                      <CardContent className="pt-0 flex items-center justify-between gap-3">
                        <span className="text-xs font-mono text-relay-ink-500">
                          {surface.stat ?? 'Live evidence inside'}
                        </span>
                        <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-relay-primary-700 group-hover:text-relay-primary-600">
                          Open
                          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                        </span>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>

              <p className="flex items-center gap-2 text-[13px] text-relay-ink-500">
                <Truck className="h-4 w-4 text-relay-ink-400" aria-hidden />
                Fulfillment and verification live under Operations — Tracking and Verification in the sidebar.
              </p>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
