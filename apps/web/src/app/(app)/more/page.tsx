'use client';

import Link from 'next/link';
import { NAV, useMe } from '@/components/shell';
import { PageHeader } from '@/components/ui';
import { ROLE_LABEL } from '@/lib/messages';
import styles from './more.module.css';

/** เมนูทั้งหมดบนมือถือ (แถบล่างมีที่แค่ 5 ช่อง) */
export default function MorePage() {
  const { me, logout } = useMe();
  const items = NAV.filter((n) => !n.roles || n.roles.includes(me.role));
  return (
    <div className={styles.page}>
      <PageHeader kicker={`${me.user.displayName} · ${ROLE_LABEL[me.role]}`} title="เมนู" />
      <nav className="card motion-list" aria-label="เมนูทั้งหมด">
        {items.map((n) => (
          <Link key={n.href} href={n.href} className={styles.row}>
            <span className={styles.icon}>{n.icon}</span>
            {n.label}
          </Link>
        ))}
      </nav>
      <button type="button" className="btn btn-block" onClick={logout}>
        ออกจากระบบ
      </button>
    </div>
  );
}
