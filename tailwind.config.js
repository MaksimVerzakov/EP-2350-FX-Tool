/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['TechnoType-bold', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        'te-bold': ['TechnoType-bold', 'sans-serif'],
        'te-medium': ['TechnoType-medium', 'sans-serif'],
        'te-regular': ['TechnoType-regular', 'sans-serif'],
        mono: ['IBM Plex Mono', 'monospace'],
      },
      /**
       * Type scale: the only text sizes the UI uses (the 44px EP logo is the one exception).
       *   te-xs 9px     labels, buttons, values, small print (the minimum)
       *   te-sm 10.5px  body text, block labels, header plates
       *   te-md 12px    card titles, empty-state titles
       *   te-lg 14px    page-level messages
       */
      /** Colour tokens: classes like bg-te-ink, text-te-muted, border-te-rule (see src/theme/tokens.ts). */
      colors: {
        te: {
          'accent': 'rgb(var(--te-accent) / <alpha-value>)',
          'accent-hover': 'rgb(var(--te-accent-hover) / <alpha-value>)',
          'accent-deep': 'rgb(var(--te-accent-deep) / <alpha-value>)',
          'edge': 'rgb(var(--te-edge) / <alpha-value>)',
          'ink': 'rgb(var(--te-ink) / <alpha-value>)',
          'ink-deep': 'rgb(var(--te-ink-deep) / <alpha-value>)',
          'ink-hover': 'rgb(var(--te-ink-hover) / <alpha-value>)',
          'ink-raised': 'rgb(var(--te-ink-raised) / <alpha-value>)',
          'muted': 'rgb(var(--te-muted) / <alpha-value>)',
          'header': 'rgb(var(--te-header) / <alpha-value>)',
          'header-deep': 'rgb(var(--te-header-deep) / <alpha-value>)',
          'surface': 'rgb(var(--te-surface) / <alpha-value>)',
          'canvas': 'rgb(var(--te-canvas) / <alpha-value>)',
          'strip': 'rgb(var(--te-strip) / <alpha-value>)',
          'face': 'rgb(var(--te-face) / <alpha-value>)',
          'face-hover': 'rgb(var(--te-face-hover) / <alpha-value>)',
          'control': 'rgb(var(--te-control) / <alpha-value>)',
          'bevel': 'rgb(var(--te-bevel) / <alpha-value>)',
          'field': 'rgb(var(--te-field) / <alpha-value>)',
          'rule': 'rgb(var(--te-rule) / <alpha-value>)',
          'line': 'rgb(var(--te-line) / <alpha-value>)',
          'line-strong': 'rgb(var(--te-line-strong) / <alpha-value>)',
          'page': 'rgb(var(--te-page) / <alpha-value>)'
        },
      },
      fontSize: {
        'te-xs': '9px',
        'te-sm': '10.5px',
        'te-md': '12px',
        'te-lg': '14px',
      },
    },
  },
  plugins: [],
}

