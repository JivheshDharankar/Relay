'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Layers,
  Menu,
  X,
  Home,
  Radar,
  Rocket,
  ClipboardList,
  Store,
  GitCompareArrows,
  ShoppingBag,
  Truck,
  ShieldCheck,
  CreditCard,
  PieChart,
  Scale,
  Users,
  Settings,
  LogOut,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Command',
    items: [{ name: 'Command', href: '/', icon: Home }],
  },
  {
    label: 'Mission',
    items: [
      { name: 'Mission', href: '/mission', icon: Rocket },
      { name: 'Runs', href: '/runs', icon: Radar },
    ],
  },
  {
    label: 'Procurement',
    items: [
      { name: 'Procurement', href: '/procurement', icon: ClipboardList },
      { name: 'Quotes', href: '/quotes', icon: GitCompareArrows },
      { name: 'Orders', href: '/orders', icon: ShoppingBag },
      { name: 'Market', href: '/market', icon: Store },
      { name: 'Suppliers', href: '/suppliers', icon: Layers },
    ],
  },
  {
    label: 'Operations',
    items: [
      { name: 'Tracking', href: '/tracking', icon: Truck },
      { name: 'Verification', href: '/verification', icon: ShieldCheck },
    ],
  },
  {
    label: 'Finance',
    items: [
      { name: 'Payments', href: '/payments', icon: CreditCard },
      { name: 'Allocation', href: '/allocation', icon: PieChart },
      { name: 'Reconciliation', href: '/reconciliation', icon: Scale },
    ],
  },
  {
    label: 'Community',
    items: [{ name: 'Community', href: '/community', icon: Users }],
  },
  {
    label: 'Account',
    items: [{ name: 'Settings', href: '/settings', icon: Settings }],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link href="/" onClick={onNavigate} className="flex items-center gap-2.5 shrink-0 min-w-0" aria-label="Relay home">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-relay-teal-600 shadow-[0_2px_10px_-2px_rgba(20,184,166,0.5)]">
        <Layers className="h-4 w-4 text-white" aria-hidden />
      </span>
      <span className="flex flex-col leading-tight min-w-0">
        <span className="font-semibold text-white text-[15px] tracking-tight truncate">Relay</span>
        <span className="text-[11px] text-relay-navy-200 truncate">Community procurement</span>
      </span>
    </Link>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex-1 overflow-y-auto py-3 space-y-4" aria-label="Primary">
      {NAV_SECTIONS.map((section) => (
        <div key={section.label}>
          <p className="px-4 font-mono text-[10.5px] text-relay-navy-200/70 mb-1">
            {section.label}
          </p>
          <ul className="space-y-px px-2">
            {section.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href + item.name}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] min-h-[36px] transition-colors',
                      active
                        ? 'bg-relay-navy-800 text-white font-semibold shadow-[inset_3px_0_0_0_#14B8A6]'
                        : 'font-medium text-relay-navy-100/80 hover:text-white hover:bg-relay-navy-800/60'
                    )}
                  >
                    <item.icon
                      className={cn(
                        'h-4 w-4 shrink-0',
                        active ? 'text-relay-teal-500' : 'text-relay-navy-200/80'
                      )}
                      aria-hidden
                    />
                    <span className="flex-1 truncate">{item.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function SidebarFooter({
  societyName,
  flatLabel,
  mandateActive,
  loading,
  authenticated,
  onSignOut,
  onNavigate,
}: {
  societyName: string | null;
  flatLabel: string | null;
  mandateActive: boolean | null;
  loading: boolean;
  authenticated: boolean;
  onSignOut: () => void;
  onNavigate?: () => void;
}) {
  if (loading) {
    return (
      <div className="px-4 py-3.5 border-t border-white/10">
        <div className="h-8 rounded-md bg-relay-navy-800 animate-pulse" aria-hidden />
      </div>
    );
  }
  if (!authenticated) {
    return (
      <div className="px-4 py-3.5 border-t border-white/10">
        <Link
          href="/login"
          onClick={onNavigate}
          className="flex items-center justify-center rounded-md bg-relay-teal-600 hover:bg-relay-teal-500 text-white text-[13px] font-semibold px-3 py-2 min-h-[38px] transition-colors"
        >
          Sign in
        </Link>
      </div>
    );
  }
  if (!societyName) {
    // Signed in but no society joined yet: guide forward, never a fake identity.
    return (
      <div className="px-4 py-3.5 border-t border-white/10">
        <Link
          href="/onboarding"
          onClick={onNavigate}
          className="flex items-center justify-center rounded-md bg-relay-teal-600 hover:bg-relay-teal-500 text-white text-[13px] font-semibold px-3 py-2 min-h-[38px] transition-colors"
        >
          Complete onboarding
        </Link>
      </div>
    );
  }
  return (
    <div className="px-4 py-3.5 border-t border-white/10">
      <p className="text-[13px] font-semibold text-white truncate">{societyName}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-relay-navy-200 truncate">
        <span className="font-mono">{flatLabel ?? 'Resident'}</span>
        {mandateActive === true && (
          <span className="inline-flex items-center gap-1 text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
            Mandate active
          </span>
        )}
        {mandateActive === false && (
          <span className="inline-flex items-center gap-1 text-amber-300">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />
            No mandate
          </span>
        )}
      </p>
      <button
        type="button"
        onClick={onSignOut}
        className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-relay-navy-200 hover:text-white transition-colors min-h-[28px]"
      >
        <LogOut className="h-3.5 w-3.5" aria-hidden />
        Sign out
      </button>
    </div>
  );
}

export interface ShellIdentity {
  societyName: string | null;
  flatLabel: string | null;
  mandateActive: boolean | null;
  loading: boolean;
  authenticated: boolean;
}

export function AppShell({
  identity,
  onSignOut,
  children,
}: {
  identity: ShellIdentity;
  onSignOut: () => void;
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Drawer a11y: Escape closes, background scroll locks while open.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  return (
    <div className="min-h-screen bg-relay-surface-bg text-relay-ink-900 lg:pl-[232px]">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-[232px] flex-col bg-relay-navy-900 z-40">
        <div className="px-4 pt-4 pb-3 border-b border-white/10">
          <Brand />
        </div>
        <SidebarNav />
        <SidebarFooter
          societyName={identity.societyName}
          flatLabel={identity.flatLabel}
          mandateActive={identity.mandateActive}
          loading={identity.loading}
          authenticated={identity.authenticated}
          onSignOut={onSignOut}
        />
      </aside>

      {/* Mobile top bar */}
      <header className="lg:hidden sticky top-0 z-40 bg-relay-navy-900">
        <div className="flex items-center justify-between gap-2 px-4 h-[56px]">
          <div className="min-w-0 flex-1">
            <Brand />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {identity.authenticated && identity.mandateActive === true && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
                Mandate active
              </span>
            )}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="inline-flex items-center justify-center p-2 rounded-md text-relay-navy-100 hover:bg-relay-navy-800 transition-colors min-h-[44px] min-w-[44px]"
              aria-label="Open navigation menu"
            >
              <Menu className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="lg:hidden fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Navigation">
          <div
            className="absolute inset-0 bg-relay-navy-950/60"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 left-0 w-[300px] max-w-[85vw] flex flex-col bg-relay-navy-900 shadow-raised">
            <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-white/10">
              <Brand onNavigate={() => setDrawerOpen(false)} />
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="inline-flex items-center justify-center p-2 rounded-md text-relay-navy-100 hover:bg-relay-navy-800 transition-colors min-h-[44px] min-w-[44px]"
                aria-label="Close navigation menu"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <SidebarNav onNavigate={() => setDrawerOpen(false)} />
            <SidebarFooter
              societyName={identity.societyName}
              flatLabel={identity.flatLabel}
              mandateActive={identity.mandateActive}
              loading={identity.loading}
              authenticated={identity.authenticated}
              onSignOut={() => {
                setDrawerOpen(false);
                onSignOut();
              }}
              onNavigate={() => setDrawerOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex flex-col min-h-screen">
        <main className="flex-1 w-full pb-10">{children}</main>
        <footer className="border-t border-relay-surface-border bg-white">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3.5 flex flex-col sm:flex-row items-center justify-between gap-1 text-xs text-relay-ink-500">
            <span>Relay — autonomous community procurement</span>
            <span>State shown is backend-verified</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
