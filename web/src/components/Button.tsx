import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Icon, Spinner, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-primary-on border border-transparent hover:bg-primary-hover active:bg-primary-hover',
  secondary:
    'bg-surface-2 text-ink border border-line hover:border-line-strong hover:bg-surface-3',
  ghost: 'bg-transparent text-ink-2 border border-transparent hover:bg-surface-2 hover:text-ink',
  danger: 'bg-danger text-danger-on border border-transparent hover:opacity-90',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-micro gap-1.5',
  md: 'h-10 px-3.5 text-[0.875rem] gap-2',
  /** 44px - the minimum for a primary touch target. Use on mobile CTAs. */
  lg: 'h-11 px-4 text-[0.9375rem] gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: IconName;
  iconEnd?: IconName;
  block?: boolean;
  children?: ReactNode;
}

export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  block = false,
): string {
  return cn(
    'inline-flex select-none items-center justify-center rounded-md font-medium',
    'transition-colors duration-fast [touch-action:manipulation]',
    'disabled:pointer-events-none disabled:opacity-45',
    VARIANTS[variant],
    SIZES[size],
    block && 'w-full',
  );
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  iconEnd,
  block = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      className={cn(buttonClasses(variant, size, block), className)}
      {...rest}
    >
      {loading ? (
        <Spinner size={size === 'sm' ? 'sm' : 'md'} />
      ) : (
        icon && <Icon name={icon} size={size === 'sm' ? 'sm' : 'md'} />
      )}
      {children}
      {iconEnd && !loading && <Icon name={iconEnd} size={size === 'sm' ? 'sm' : 'md'} />}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Required: an icon-only control must announce itself. */
  label: string;
  variant?: ButtonVariant;
}

export function IconButton({ icon, label, variant = 'ghost', className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors duration-fast',
        '[touch-action:manipulation] disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size="lg" />
    </button>
  );
}
