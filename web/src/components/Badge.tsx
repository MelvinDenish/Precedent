import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Icon, type IconName } from './Icon';

/**
 * Badge tones map to THE COLOUR LAW:
 *   neutral   - a fact with no valence
 *   positive  - confirmed / succeeded
 *   danger    - failed, or disputed and awaiting a human
 *   warn      - actionable warning (budget, quota). NOT uncertainty.
 *   unknown   - hueless + dashed + hatched. The absence treatment. Uncertainty
 *               and missing data use THIS, never `warn`.
 *
 * `evidence` is deliberately absent: amber belongs to CitationChip alone.
 */
export type BadgeTone = 'neutral' | 'positive' | 'danger' | 'warn' | 'unknown';

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-line bg-surface-1 text-ink-2',
  positive: 'border-positive/35 bg-positive-wash text-positive',
  danger: 'border-danger/35 bg-danger-wash text-danger',
  warn: 'border-warn/35 bg-warn-wash text-warn',
  unknown: 'border-dashed border-line-strong bg-transparent text-ink-3 absence',
};

export interface BadgeProps {
  tone?: BadgeTone;
  icon?: IconName;
  children: ReactNode;
  className?: string;
  title?: string;
}

export function Badge({ tone = 'neutral', icon, children, className, title }: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5',
        'font-mono text-label uppercase tracking-wider',
        TONES[tone],
        className,
      )}
    >
      {icon && <Icon name={icon} size="sm" />}
      {children}
    </span>
  );
}

/** A label:value pair rendered as one unit. Value is mono + tabular. */
export function Stat({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="font-mono text-label uppercase tracking-wider text-ink-3">{label}</div>
      <div className="tnum mt-1 font-mono text-lg font-medium text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-micro text-ink-3">{sub}</div>}
    </div>
  );
}
