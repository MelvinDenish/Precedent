/**
 * PRECEDENT design tokens. Direction: "Marginalia".
 *
 * Every colour here resolves to a CSS variable declared in src/index.css, so
 * light/dark is one variable swap and components never carry a hex code.
 *
 * NOTE ON DARK MODE: `darkMode` is intentionally left at its default and no
 * `dark:` utility is used anywhere in the app. The variable layer already
 * handles `prefers-color-scheme` plus the explicit `[data-theme]` override;
 * running both mechanisms is how a theme desyncs.
 */

/** @param {string} v */
const c = (v) => `rgb(var(${v}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          0: c('--surface-0'),
          1: c('--surface-1'),
          2: c('--surface-2'),
          3: c('--surface-3'),
        },
        line: {
          DEFAULT: c('--line'),
          subtle: c('--line-subtle'),
          strong: c('--line-strong'),
        },
        ink: {
          DEFAULT: c('--ink'),
          2: c('--ink-2'),
          3: c('--ink-3'),
          inverse: c('--ink-inverse'),
        },
        primary: {
          DEFAULT: c('--primary'),
          hover: c('--primary-hover'),
          on: c('--on-primary'),
          ink: c('--primary-ink'),
        },
        /* Amber. Citations only. See THE COLOUR LAW in index.css. */
        evidence: {
          DEFAULT: c('--evidence'),
          ink: c('--evidence-ink'),
          line: c('--evidence-line'),
          wash: c('--evidence-wash'),
        },
        positive: {
          DEFAULT: c('--positive'),
          wash: c('--positive-wash'),
        },
        danger: {
          DEFAULT: c('--danger'),
          wash: c('--danger-wash'),
          on: c('--on-danger'),
        },
        warn: {
          DEFAULT: c('--warn'),
          wash: c('--warn-wash'),
        },
        focus: c('--focus'),
        scrim: c('--scrim'),
      },
      fontFamily: {
        sans: [
          'IBM Plex Sans',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        serif: ['IBM Plex Serif', 'ui-serif', 'Georgia', 'Cambria', 'serif'],
        mono: [
          'IBM Plex Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      fontSize: {
        /* Mono micro-label: stage names, regime labels, citation refs. */
        label: ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.06em' }],
        micro: ['0.75rem', { lineHeight: '1.1rem', letterSpacing: '0.02em' }],
      },
      borderRadius: {
        sm: '5px',
        DEFAULT: '7px',
        md: '8px',
        lg: '12px',
        xl: '16px',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        raised: 'var(--shadow-raised)',
        popover: 'var(--shadow-popover)',
      },
      spacing: {
        rail: '15.5rem',
        header: '3.5rem',
      },
      maxWidth: {
        measure: '68ch',
        shell: '78rem',
      },
      zIndex: {
        nav: '20',
        sticky: '30',
        scrim: '40',
        dialog: '50',
        popover: '60',
        toast: '70',
      },
      transitionDuration: {
        fast: '150ms',
        DEFAULT: '200ms',
      },
      animation: {
        rise: 'precedent-rise 200ms ease-out both',
        fade: 'precedent-fade 150ms ease-out both',
        sheet: 'precedent-sheet 220ms cubic-bezier(0.22, 1, 0.36, 1) both',
        spin: 'precedent-spin 900ms linear infinite',
      },
    },
  },
  plugins: [],
};
