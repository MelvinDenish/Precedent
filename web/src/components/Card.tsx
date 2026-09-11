import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** `quiet` drops the shadow - use inside another card or a dense grid. */
  tone?: 'raised' | 'quiet';
}

export function Card({ tone = 'raised', className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-line bg-surface-2',
        tone === 'raised' ? 'shadow-card' : 'shadow-none',
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({
  title,
  kicker,
  actions,
  className,
}: {
  title: ReactNode;
  kicker?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 border-b border-line-subtle px-4 py-3 sm:px-5',
        className,
      )}
    >
      <div className="min-w-0">
        {kicker && (
          <div className="mb-1 font-mono text-label uppercase text-ink-3">{kicker}</div>
        )}
        <h2 className="truncate text-[0.9375rem] font-semibold">{title}</h2>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 py-4 sm:px-5', className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-t border-line-subtle bg-surface-1 px-4 py-3 sm:px-5',
        className,
      )}
      {...rest}
    />
  );
}

/** Section heading used outside cards. Kicker is mono, by house rule. */
export function SectionHeading({
  kicker,
  title,
  description,
  actions,
}: {
  kicker?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {kicker && <div className="mb-1 font-mono text-label uppercase text-ink-3">{kicker}</div>}
        <h1 className="text-xl font-semibold sm:text-2xl">{title}</h1>
        {description && <p className="mt-1.5 max-w-measure text-sm text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
