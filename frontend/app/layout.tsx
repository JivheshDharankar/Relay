import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { AppFrame } from '@/components/shell/AppFrame';

const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Relay | Autonomous Community Procurement',
  description:
    'Tell Relay what you need. Relay understands, procures, fulfills, and proves it — inside your authorized mandate.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-relay-surface-bg text-relay-ink-900 antialiased selection:bg-relay-primary-100 selection:text-relay-primary-700">
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
