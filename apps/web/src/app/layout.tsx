import '@fontsource/ibm-plex-sans-thai/thai-400.css';
import '@fontsource/ibm-plex-sans-thai/thai-600.css';
import '@fontsource/ibm-plex-sans-thai/latin-400.css';
import '@fontsource/ibm-plex-sans-thai/latin-600.css';
import '@fontsource/anuphan/thai-600.css';
import '@fontsource/anuphan/latin-600.css';
import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: { default: 'ร้านเช่า', template: '%s · ร้านเช่า' },
  description: 'ระบบบริหารร้านเช่ารถและอุปกรณ์',
  applicationName: 'ร้านเช่า',
  appleWebApp: { capable: true, title: 'ร้านเช่า', statusBarStyle: 'default' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#2a211b',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
