import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * Skeletons reserve the exact space the real content will take, so nothing
 * jumps when data lands (CLS is a real cost at 2am on a phone). The shimmer is
 * switched off automatically under prefers-reduced-motion by the base layer.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('shimmer rounded-sm bg-surface-1 ring-1 ring-inset ring-line-subtle', className)}
    />
  );
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3.5', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-lg border border-line bg-surface-2 p-4 shadow-card', className)}>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-5 w-3/5" />
      <SkeletonText lines={2} className="mt-4" />
      <div className="mt-4 flex gap-2">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-16" />
      </div>
    </div>
  );
}

export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-line-subtle">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={cn('h-3.5', c === 0 ? 'flex-1' : 'w-16')} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Announce a loading region to assistive tech without stealing focus. */
export function LoadingRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
