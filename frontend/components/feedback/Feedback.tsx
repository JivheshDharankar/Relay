import React from 'react';
import { Loader2, Inbox, AlertTriangle, Clock, Lock, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';

interface FeedbackShellProps {
  icon: React.ReactNode;
  title: string;
  description?: string;
  detail?: string;
  action?: React.ReactNode;
  className?: string;
}

function FeedbackShell({ icon, title, description, detail, action, className }: FeedbackShellProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center px-6 py-10 rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none',
        className
      )}
      role="status"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-relay-navy-50 text-relay-ink-600 mb-4">
        {icon}
      </div>
      <h3 className="text-[15px] font-semibold text-relay-ink-900 tracking-tight">{title}</h3>
      {description && (
        <p className="mt-1.5 text-sm text-relay-ink-600 leading-relaxed max-w-md">{description}</p>
      )}
      {detail && (
        <p className="mt-2.5 text-xs font-mono text-relay-ink-600 bg-relay-navy-50 border border-relay-surface-border rounded-md px-2.5 py-1.5 max-w-full break-words">
          {detail}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function LoadingState({
  title = 'Loading',
  description,
  className,
}: {
  title?: string;
  description?: string;
  className?: string;
}) {
  return (
    <FeedbackShell
      icon={<Loader2 className="h-5 w-5 animate-spin text-relay-primary-600" aria-hidden />}
      title={title}
      description={description}
      className={cn('border-transparent shadow-none bg-transparent', className)}
    />
  );
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  className,
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}) {
  return (
    <FeedbackShell
      icon={<Inbox className="h-5 w-5" aria-hidden />}
      title={title}
      description={description}
      className={className}
      action={
        actionLabel && onAction ? (
          <Button variant="outline" size="sm" onClick={onAction}>
            {actionLabel}
          </Button>
        ) : undefined
      }
    />
  );
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  detail,
  onRetry,
  className,
}: {
  title?: string;
  description?: string;
  detail?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <FeedbackShell
      icon={<AlertTriangle className="h-5 w-5 text-relay-danger-600" aria-hidden />}
      title={title}
      description={description}
      detail={detail}
      className={className}
      action={
        onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}

export function TimeoutState({ onRetry, className }: { onRetry?: () => void; className?: string }) {
  return (
    <FeedbackShell
      icon={<Clock className="h-5 w-5 text-relay-warn-600" aria-hidden />}
      title="Request timed out"
      description="The Relay backend took too long to respond. Your request may still be processing — check order history before retrying."
      className={className}
      action={
        onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}

export function OfflineState({ onRetry, className }: { onRetry?: () => void; className?: string }) {
  return (
    <FeedbackShell
      icon={<WifiOff className="h-5 w-5 text-relay-ink-600" aria-hidden />}
      title="Cannot reach Relay backend"
      description="Check that the backend is running and your network connection is working."
      className={className}
      action={
        onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry connection
          </Button>
        ) : undefined
      }
    />
  );
}

export function AuthRequiredState({
  description = 'Sign in to view your procurement context. Relay never shows another resident\u2019s data.',
  onSignIn,
  className,
}: {
  description?: string;
  onSignIn?: () => void;
  className?: string;
}) {
  return (
    <FeedbackShell
      icon={<Lock className="h-5 w-5 text-relay-ink-600" aria-hidden />}
      title="Sign in required"
      description={description}
      className={className}
      action={
        onSignIn ? (
          <Button variant="primary" size="sm" onClick={onSignIn}>
            Sign in
          </Button>
        ) : undefined
      }
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-relay-navy-50', className)} />;
}
