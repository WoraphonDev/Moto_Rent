import type { ReactNode } from 'react';
import { OfflineBanner } from '@/components/offline-banner';
import { Shell } from '@/components/shell';
import { SwRegister } from '@/components/sw-register';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Shell>
      <SwRegister />
      <OfflineBanner />
      {children}
    </Shell>
  );
}
