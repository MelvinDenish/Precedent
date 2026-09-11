import type { ReactElement, SVGProps } from 'react';
import { cn } from '../lib/cn';

/**
 * One icon family, one stroke width (1.5), one 24-box. Paths are Lucide-style
 * geometry drawn inline so the app ships zero icon dependencies and zero
 * emoji. Sizes come from the token set below - never an arbitrary px value.
 */
export type IconName =
  | 'upload'
  | 'file'
  | 'check'
  | 'checkCircle'
  | 'alertTriangle'
  | 'alertCircle'
  | 'info'
  | 'close'
  | 'chevronRight'
  | 'chevronDown'
  | 'externalLink'
  | 'quote'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'menu'
  | 'loader'
  | 'graph'
  | 'book'
  | 'library'
  | 'arrowRight'
  | 'logout'
  | 'plus'
  | 'trash'
  | 'clock';

const PATHS: Record<IconName, ReactElement> = {
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5 10-11" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.5 2.5 2.5 5.5-6" />
    </>
  ),
  alertTriangle: (
    <>
      <path d="M10.3 4.3 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4" />
      <path d="M12 17h.01" />
    </>
  ),
  alertCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5" />
      <path d="M12 16h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4.5" />
      <path d="M12 8h.01" />
    </>
  ),
  close: (
    <>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </>
  ),
  chevronRight: <path d="m9 5 7 7-7 7" />,
  chevronDown: <path d="m5 9 7 7 7-7" />,
  externalLink: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </>
  ),
  quote: (
    <>
      <path d="M7 5H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3v2a3 3 0 0 1-3 3" />
      <path d="M20 5h-3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3v2a3 3 0 0 1-3 3" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  loader: <path d="M12 3a9 9 0 1 0 9 9" />,
  graph: (
    <>
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="16" r="2.5" />
      <circle cx="12" cy="6" r="2.5" />
      <path d="m10.6 8 -3.2 8M13.9 7.6 16.6 14" />
    </>
  ),
  book: (
    <>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5Z" />
      <path d="M5 19.5A1.5 1.5 0 0 1 6.5 18H19v3H6.5A1.5 1.5 0 0 1 5 19.5Z" />
    </>
  ),
  library: (
    <>
      <path d="M4 5v14M9 5v14" />
      <path d="m13.5 5.8 4.6 1.3-3.7 12.2-4.6-1.3z" />
    </>
  ),
  arrowRight: (
    <>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
      <path d="M10 8 6 12l4 4" />
      <path d="M6 12h9" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
};

const SIZES = { sm: 14, md: 16, lg: 20, xl: 24 } as const;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: keyof typeof SIZES;
  /** Give a label only when the icon is the sole carrier of meaning. */
  label?: string;
}

export function Icon({ name, size = 'md', label, className, ...rest }: IconProps) {
  const px = SIZES[size];
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      className={cn('shrink-0', className)}
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

export function Spinner({ size = 'md', className }: { size?: keyof typeof SIZES; className?: string }) {
  return <Icon name="loader" size={size} className={cn('animate-spin', className)} />;
}
