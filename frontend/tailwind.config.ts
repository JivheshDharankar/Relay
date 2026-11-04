import type { Config } from 'tailwindcss';

/**
 * Relay design system — premium dark-first.
 * Spec tokens (source of truth):
 *   bg #0A0D12 · sidebar #0D1117 · surface #12161D · raised #1A1F28
 *   border #262C37 · subtle border #1E242E
 *   text #E8EAED · secondary #9AA3B2 · faint #8A94A6
 *   accent #0866FF · accent text #5B9BFF
 *   success #2FBF71 · warning #F5A524 · danger #F05252
 *   gradient linear-gradient(135deg, #0866FF, #7A3CFF) — primary CTA / active emphasis only.
 * Legacy `relay.*` names are remapped onto these values so every existing
 * surface inherits the dark system without hardcoded per-page colors.
 */
const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        relay: {
          navy: {
            950: '#06080C',
            900: '#0D1117',
            850: '#12161D',
            800: '#1A1F28',
            700: '#262C37',
            600: '#2E3644',
            200: '#B9C4D3',
            100: '#D6DEE8',
            50: '#1A1F28',
          },
          primary: {
            700: '#5B9BFF',
            600: '#0866FF',
            500: '#5B9BFF',
            100: '#16294D',
            50: '#111E33',
          },
          teal: {
            700: '#5AD6C3',
            600: '#14B8A6',
            500: '#2DD4BF',
            100: '#12302C',
            50: '#0B2422',
          },
          success: {
            700: '#5AD68F',
            600: '#2FBF71',
            500: '#2FBF71',
            100: '#123324',
            50: '#0E2417',
          },
          ink: {
            900: '#E8EAED',
            800: '#D8DCE3',
            700: '#B9C0CC',
            600: '#9AA3B2',
            500: '#9AA3B2',
            400: '#8A94A6',
            300: '#5C6575',
          },
          surface: {
            bg: '#0A0D12',
            card: '#12161D',
            raised: '#1A1F28',
            border: '#262C37',
            subtle: '#1E242E',
            sunken: '#0D1117',
          },
          warn: {
            700: '#F7B955',
            600: '#F5A524',
            500: '#F5A524',
            100: '#33270E',
            50: '#241C08',
          },
          danger: {
            700: '#F87171',
            600: '#F05252',
            500: '#F05252',
            100: '#331616',
            50: '#241010',
          },
          accent: '#0866FF',
          accenttext: '#5B9BFF',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      backgroundImage: {
        'relay-gradient': 'linear-gradient(135deg, #0866FF, #7A3CFF)',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgba(0, 0, 0, 0.35)',
        raised: '0 8px 24px -8px rgba(0, 0, 0, 0.5)',
        glow: '0 0 0 3px rgba(8, 102, 255, 0.25)',
        hero: '0 18px 44px -16px rgba(0, 0, 0, 0.6)',
        proof: '0 10px 30px -12px rgba(47, 191, 113, 0.22)',
      },
    },
  },
  plugins: [],
};

export default config;
