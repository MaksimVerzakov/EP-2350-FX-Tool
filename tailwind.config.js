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

