import '@fontsource/anuphan/latin-400.css';
import '@fontsource/anuphan/thai-400.css';
import type { ReactNode } from 'react';
import styles from './public.module.css';

/** โครงหน้าของลูกค้า (ภาษาอังกฤษ ไม่มีเมนูพนักงาน) · ใช้ทั้ง /book และ /b */
export function PublicFrame({ shopName, children }: { shopName?: string; children: ReactNode }) {
  return (
    <div className={styles.shell} lang="en">
      <header className={styles.top}>
        <span className="sun" aria-hidden="true" />
        <span className={styles.brand}>{shopName ?? 'Rental'}</span>
      </header>
      <main className={styles.wrap}>{children}</main>
    </div>
  );
}
