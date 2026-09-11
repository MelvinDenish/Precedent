import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { Icon } from './Icon';

const FIELD_BASE = cn(
  'w-full rounded-md border bg-surface-1 px-3 text-[0.9375rem] text-ink',
  'transition-colors duration-fast placeholder:text-ink-3',
  'disabled:cursor-not-allowed disabled:opacity-50',
  /* 44px: mobile inputs must clear the touch minimum, and 16px-equivalent
     text avoids the iOS auto-zoom on focus. */
  'h-11',
);

function fieldClasses(invalid: boolean): string {
  return cn(FIELD_BASE, invalid ? 'border-danger' : 'border-line hover:border-line-strong');
}

interface FieldShellProps {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}

function FieldShell({ id, label, hint, error, required, children }: FieldShellProps) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 block text-micro font-medium text-ink-2">
        {label}
        {required && (
          <span className="ml-1 text-danger" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-micro text-ink-3">
          {hint}
        </p>
      )}
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-1.5 flex items-start gap-1.5 text-micro text-danger"
        >
          <Icon name="alertCircle" size="sm" className="mt-px" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** Mono + tabular: use for years, marks, ids. */
  numeric?: boolean;
}

export function Input({ label, hint, error, numeric, className, required, ...rest }: InputProps) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required}>
      <input
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cn(fieldClasses(Boolean(error)), numeric && 'tnum font-mono', className)}
        {...rest}
      />
    </FieldShell>
  );
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

export function Select({ label, hint, error, className, required, children, ...rest }: SelectProps) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required}>
      <div className="relative">
        <select
          id={id}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          className={cn(fieldClasses(Boolean(error)), 'appearance-none pr-9', className)}
          {...rest}
        >
          {children}
        </select>
        <Icon
          name="chevronDown"
          size="md"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-3"
        />
      </div>
    </FieldShell>
  );
}

/** Summary shown above a form when several fields failed at once. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger-wash px-3 py-2.5 text-micro text-danger"
    >
      <Icon name="alertTriangle" size="md" className="mt-px" />
      <span>{message}</span>
    </div>
  );
}
