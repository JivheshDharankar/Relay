import type { Config } from 'tailwindcss';

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
          // Structural shell: Midnight Navy.
          navy: {
            950: '#0B1220',
            900: '#101827',
            850: '#17223A',
            800: '#1F2E4D',
            700: '#2C4066',
            600: '#3D5685',
            200: '#B9C4D3',
            100: '#D6DEE8',
            50: '#E8EDF2',
          },
          // Primary actions / information: Blue.
          primary: {
            700: '#1D4ED8',
            600: '#2563EB',
            500: '#3B82F6',
            100: '#DBEAFE',
            50: '#EFF6FF',
          },
          // Relay accent: Teal (brand mark, active states, selection).
          teal: {
            700: '#0D5F57',
            600: '#0F766E',
            500: '#14B8A6',
            100: '#CCFBF1',
            50: '#F0FDF9',
          },
          // Verified: Emerald.
          success: {
            700: '#15803D',
            600: '#16A34A',
            500: '#22C55E',
            100: '#DCFCE7',
            50: '#F0FDF4',
          },
          ink: {
            900: '#172033',
            800: '#232F45',
            700: '#334155',
            600: '#475569',
            500: '#64748B',
            400: '#94A3B8',
            300: '#B9C4D3',
          },
          surface: {
            bg: '#E8EDF2',
            card: '#FFFFFF',
            border: '#CBD5E1',
            sunken: '#F8FAFC',
          },
          warn: {
            700: '#B45309',
            600: '#D97706',
            100: '#FEF3C7',
            50: '#FFFBEB',
          },
          danger: {
            700: '#B91C1C',
            600: '#DC2626',
            100: '#FEE2E2',
            50: '#FEF2F2',
          },
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgba(11, 18, 32, 0.06), 0 1px 3px 0 rgba(11, 18, 32, 0.05)',
        raised: '0 6px 20px -6px rgba(11, 18, 32, 0.18), 0 2px 6px -2px rgba(11, 18, 32, 0.10)',
        glow: '0 0 0 3px rgba(37, 99, 235, 0.20)',
        hero: '0 18px 44px -16px rgba(11, 18, 32, 0.45), 0 6px 18px -8px rgba(11, 18, 32, 0.30)',
        proof: '0 10px 30px -12px rgba(13, 95, 87, 0.28), 0 3px 10px -4px rgba(11, 18, 32, 0.16)',
      },
    },
  },
  plugins: [],
};

export default config;
