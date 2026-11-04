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
  icon: React.ComponentType<{ className?: string; strokeWidth?: number | string }>;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Command',
    items: [{ name: 'Command Center', href: '/', icon: Home }],
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
    <Link href="/" onClick={onNavigate} className="flex items-center gap-3 shrink-0 min-w-0" aria-label="Relay home">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-relay-gradient">
        <Layers className="h-[18px] w-[18px] text-white" strokeWidth={1.8} aria-hidden />
      </span>
      <span className="flex flex-col leading-tight min-w-0">
        <span className="font-semibold text-white text-[15px] tracking-tight truncate">Relay</span>
        <span className="text-[11px] text-[#8A94A6] truncate">Community procurement</span>
      </span>
    </Link>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex-1 overflow-y-auto py-4 space-y-5" aria-label="Primary">
      {NAV_SECTIONS.map((section) => (
        <div key={section.label}>
          <p className="px-5 font-mono text-xs uppercase tracking-[0.14em] text-[#8A94A6] mb-1.5">
            {section.label}
          </p>
          <ul className="space-y-px px-3">
            {section.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href + item.name}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-[10px] px-3 py-2 text-[14px] min-h-[40px] transition-colors duration-150',
                      active
                        ? 'bg-[#111E33] text-white font-semibold shadow-[inset_2px_0_0_0_#0866FF]'
                        : 'font-medium text-[#9AA3B2] hover:text-[#E8EAED] hover:bg-[#1A1F28]'
                    )}
                  >
                    <item.icon
                      className={cn(
                        'h-[18px] w-[18px] shrink-0',
                        active ? 'text-[#5B9BFF]' : 'text-[#8A94A6]'
                      )}
                      strokeWidth={1.8}
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
      <div className="px-4 py-4 border-t border-[#1E242E]">
        <div className="h-9 rounded-[10px] bg-[#1A1F28] animate-pulse" aria-hidden />
      </div>
    );
  }
  if (!authenticated) {
    return (
      <div className="px-4 py-4 border-t border-[#1E242E]">
        <Link
          href="/login"
          onClick={onNavigate}
          className="flex items-center justify-center rounded-full bg-relay-gradient text-white text-[13px] font-semibold px-3 py-2 min-h-[40px] transition-opacity hover:opacity-90"
        >
          Sign in
        </Link>
      </div>
    );
  }
  if (!societyName) {
    return (
      <div className="px-4 py-4 border-t border-[#1E242E]">
        <Link
          href="/onboarding"
          onClick={onNavigate}
          className="flex items-center justify-center rounded-full bg-relay-gradient text-white text-[13px] font-semibold px-3 py-2 min-h-[40px] transition-opacity hover:opacity-90"
        >
          Complete onboarding
        </Link>
      </div>
    );
  }
  return (
    <div className="px-5 py-4 border-t border-[#1E242E]">
      <p className="text-[13px] font-semibold text-white truncate">{societyName}</p>
      <p className="mt-1 flex items-center gap-1.5 text-xs text-[#8A94A6] truncate">
        <span className="font-mono">{flatLabel ?? 'Resident'}</span>
        {mandateActive === true && (
          <span className="inline-flex items-center gap-1 text-[#5AD68F]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#2FBF71]" aria-hidden />
            Mandate active
          </span>
        )}
        {mandateActive === false && (
          <span className="inline-flex items-center gap-1 text-[#F7B955]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#F5A524]" aria-hidden />
            No mandate
          </span>
        )}
      </p>
      <button
        type="button"
        onClick={onSignOut}
        className="mt-2 flex items-center gap-1.5 text-xs font-medium text-[#8A94A6] hover:text-white transition-colors min-h-[28px]"
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
    <div className="min-h-screen bg-[#0A0D12] text-[#E8EAED] lg:pl-[248px]">
      {/* Desktop sidebar — 248px, spec §2.1 */}
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-[248px] flex-col bg-[#0D1117] border-r border-[#262C37] z-40">
        <div className="px-5 pt-5 pb-4 border-b border-[#1E242E]">
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
      <header className="lg:hidden sticky top-0 z-40 bg-[#0D1117] border-b border-[#262C37]">
        <div className="flex items-center justify-between gap-2 px-4 h-[60px]">
          <div className="min-w-0 flex-1">
            <Brand />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {identity.authenticated && identity.mandateActive === true && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[#5AD68F]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#2FBF71]" aria-hidden />
                Mandate active
              </span>
            )}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="inline-flex items-center justify-center p-2 rounded-[10px] text-[#9AA3B2] hover:bg-[#1A1F28] hover:text-white transition-colors min-h-[44px] min-w-[44px]"
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
            className="absolute inset-0 bg-black/60"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 left-0 w-[300px] max-w-[85vw] flex flex-col bg-[#0D1117] border-r border-[#262C37]">
            <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-[#1E242E]">
              <Brand onNavigate={() => setDrawerOpen(false)} />
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="inline-flex items-center justify-center p-2 rounded-[10px] text-[#9AA3B2] hover:bg-[#1A1F28] hover:text-white transition-colors min-h-[44px] min-w-[44px]"
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
        <footer className="border-t border-[#1E242E]">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-1 text-xs text-[#8A94A6]">
            <span>Relay — autonomous community procurement</span>
            <span>The model recommends. Deterministic code verifies, authorizes and executes.</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
