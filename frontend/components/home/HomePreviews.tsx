import React from 'react';
import Link from 'next/link';
import { ArrowRight, Radar, Store, Scale, ShoppingBag, Users } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { RelayIntelligence } from '@/components/intelligence/RelayIntelligence';
import { formatDateTime, formatMoneyCompact, formatQuantity } from '@/lib/format';
import { getRunIntelligence } from '@/lib/workflow/intelligence';
import { runIdOf, type ProcurementRun } from '@/lib/workflow/types';
import type { CommunityData, PortalOrder, VerifiedSupplier } from '@/types';

function PreviewLink({ href, children }: { href: string; children: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-xs font-semibold text-relay-primary-600 hover:text-relay-primary-700 min-h-[32px]"
    >
      {children}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
    </Link>
  );
}

export function ActiveRunPreview({ run }: { run: ProcurementRun | null }) {
  if (!run) return null;
  const id = runIdOf(run);
  if (!id) return null;
  const failed = run.status === 'failed';
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Radar className="h-4 w-4 text-relay-ink-400" aria-hidden />
            Latest run
          </CardTitle>
          <Link
            href={`/runs/${id}`}
            className="inline-flex items-center gap-1 text-xs font-semibold text-relay-primary-700 hover:text-relay-primary-600 min-h-[32px]"
          >
            Open run
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
        <CardDescription className="line-clamp-2">
          “{run.prompt}”
        </CardDescription>
        <p className={`text-xs mt-2 tnum ${failed ? 'text-relay-warn-700' : 'text-relay-ink-500'}`}>
          {failed ? 'Could not complete' : 'Completed'}
          {run.finishedAt && <> · {formatDateTime(run.finishedAt)}</>}
        </p>
      </CardHeader>
    </Card>
  );
}

export function IntelligencePreview({ run }: { run: ProcurementRun | null }) {
  if (!run) return null;
  const id = runIdOf(run);
  const notes = getRunIntelligence(run);
  if (notes.length === 0 || !id) return null;
  return <RelayIntelligence notes={notes} href={`/runs/${id}`} compact />;
}

export function MarketPreview({
  suppliers,
  loading,
}: {
  suppliers: VerifiedSupplier[] | null;
  loading: boolean;
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Store className="h-4 w-4 text-relay-primary-600" aria-hidden />
            Market Intelligence
          </CardTitle>
          <PreviewLink href="/market">Explore market</PreviewLink>
        </div>
        <CardDescription>Verified suppliers serving the community.</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {loading && !suppliers ? (
          <div className="min-h-[52px]" aria-hidden />
        ) : !suppliers || suppliers.length === 0 ? (
          <p className="text-sm text-relay-ink-600 leading-relaxed">
            Discover qualified suppliers serving your community.
          </p>
        ) : (
          <ul className="space-y-2">
            {suppliers.slice(0, 3).map((s) => (
              <li key={s.id} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium text-relay-ink-900 truncate">{s.name}</span>
                <span className="text-xs text-relay-ink-600 tnum shrink-0">
                  {s.reliabilityScorePct}% · {s.slaHours}h SLA
                </span>
              </li>
            ))}
            {suppliers.length > 3 && (
              <li className="text-xs text-relay-ink-500">+{suppliers.length - 3} more verified</li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function ProofPreview({ run }: { run: ProcurementRun | null }) {
  const recon = run?.fullCycle?.reconciliation ?? null;
  const balanced =
    recon?.isReconciled === true &&
    recon.status === 'RECONCILED' &&
    recon.quantityReconciliation.passed &&
    recon.financialReconciliation.passed;
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Scale className="h-4 w-4 text-relay-success-600" aria-hidden />
            Procurement Proof
          </CardTitle>
          <PreviewLink href="/reconciliation">View proof</PreviewLink>
        </div>
        <CardDescription>Four-pillar financial conservation.</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {!run || !recon ? (
          <p className="text-sm text-relay-ink-600 leading-relaxed">
            Every rupee is traceable from demand to resident allocation. Proof appears
            here after a verified run.
          </p>
        ) : (
          <div>
            <p className={`font-mono text-2xl font-semibold tracking-tight tnum ${balanced ? 'text-relay-success-700' : 'text-relay-warn-700'}`}>
              ₹{String(recon.financialReconciliation.difference)}
            </p>
            <p className="text-xs text-relay-ink-600 mt-1">
              reported discrepancy · status {recon.status}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function OrdersPreview({
  orders,
  loading,
}: {
  orders: PortalOrder[] | null;
  loading: boolean;
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <ShoppingBag className="h-4 w-4 text-relay-primary-600" aria-hidden />
            Orders
          </CardTitle>
          <PreviewLink href="/orders">View orders</PreviewLink>
        </div>
        <CardDescription>Private autonomous execution history.</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {loading && !orders ? (
          <div className="min-h-[52px]" aria-hidden />
        ) : !orders || orders.length === 0 ? (
          <p className="text-sm text-relay-ink-600 leading-relaxed">
            Your autonomous procurement history appears here.
          </p>
        ) : (
          <ul className="space-y-2">
            {orders.slice(0, 3).map((o) => (
              <li key={o.id} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium text-relay-ink-900 truncate">
                  {o.items[0]?.productName ?? 'Order'}
                  {o.items.length > 1 && <span className="text-relay-ink-500"> +{o.items.length - 1}</span>}
                </span>
                <span className="text-xs font-semibold text-relay-ink-900 tnum shrink-0">
                  {formatMoneyCompact(o.totalAmount, o.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function CommunityPreview({
  community,
  loading,
}: {
  community: CommunityData | null;
  loading: boolean;
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-relay-primary-600" aria-hidden />
            Community
          </CardTitle>
          <PreviewLink href="/community">View community</PreviewLink>
        </div>
        <CardDescription>Anonymous pooled demand, collective savings.</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {loading && !community ? (
          <div className="min-h-[52px]" aria-hidden />
        ) : !community || community.activeDemandPools.length === 0 ? (
          <p className="text-sm text-relay-ink-600 leading-relaxed">
            Pool compatible demand privately to unlock better procurement terms.
          </p>
        ) : (
          <ul className="space-y-2">
            {community.activeDemandPools.slice(0, 3).map((p) => (
              <li key={p.productId} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium text-relay-ink-900 truncate">{p.productName}</span>
                <span className="text-xs text-relay-ink-600 tnum shrink-0">
                  {formatQuantity(p.totalQuantity, p.unit)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
