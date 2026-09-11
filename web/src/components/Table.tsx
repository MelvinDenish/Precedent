import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

/**
 * Dense data table. The only element allowed to exceed the page width, and
 * only inside its own horizontal scroller - the page body never scrolls
 * sideways.
 */
export function TableScroller({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0', className)}
      tabIndex={0}
      role="region"
      {...rest}
    />
  );
}

export function Table({ className, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <table
      className={cn('w-full min-w-[34rem] border-collapse text-left text-sm', className)}
      {...rest}
    />
  );
}

export function Thead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn('sticky top-0 z-10 bg-surface-1 text-ink-3', className)}
      {...rest}
    />
  );
}

export function Tbody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('divide-y divide-line-subtle', className)} {...rest} />;
}

export function Tr({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn('transition-colors duration-fast hover:bg-surface-1', className)} {...rest} />
  );
}

export interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right';
}

export function Th({ align = 'left', className, children, ...rest }: ThProps) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap border-b border-line px-3 py-2 font-mono text-label font-medium uppercase tracking-wider',
        align === 'right' && 'text-right',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right';
  /** Mono + tabular figures. Every statistic in a table should set this. */
  numeric?: boolean;
}

export function Td({ align, numeric, className, children, ...rest }: TdProps) {
  return (
    <td
      className={cn(
        'px-3 py-2.5 align-middle text-ink-2',
        numeric && 'tnum font-mono text-ink',
        (align ?? (numeric ? 'right' : 'left')) === 'right' && 'text-right',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

export function TableEmpty({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center text-sm text-ink-3">
        {children}
      </td>
    </tr>
  );
}
