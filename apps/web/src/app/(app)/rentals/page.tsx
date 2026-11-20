'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Empty, Notice, PageHeader, useLoad } from '@/components/ui';
import { api, type RentalSummary } from '@/lib/api';
import { dateTimeText, dueText, overdueText } from '@/lib/format';
import styles from './rentals.module.css';

type Tab = 'active' | 'returned';

/** สัญญาที่เช่าอยู่ / คืนแล้ว · ทางลัดไปรับคืน */
export default function RentalsPage() {
  const [tab, setTab] = useState<Tab>('active');
  const list = useLoad(() => api.get<RentalSummary[]>(`/v1/rentals${tab === 'returned' ? '?status=returned' : ''}`).then((r) => r.data), [tab]);
  const rows = list.data ?? [];
  const overdue = rows.filter((r) => r.overdue).length;

  return (
    <div className={styles.page}>
      <PageHeader
        kicker={tab === 'active' ? `เช่าอยู่ ${rows.length} · เลยกำหนด ${overdue}` : 'คืนแล้วล่าสุด'}
        title="สัญญา / รับคืน"
        actions={
          <Link className="btn btn-primary" href="/checkout" style={{ minHeight: 48 }}>
            + ปล่อยเช่า
          </Link>
        }
      />
      <div className={styles.tabs} role="tablist" aria-label="สถานะสัญญา">
        {(
          [
            ['active', 'เช่าอยู่'],
            ['returned', 'คืนแล้ว'],
          ] as const
        ).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={styles.tab} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <Notice notice={list.error ? { kind: 'danger', text: list.error } : null} />

      <section className="card" aria-live="polite">
        {list.data && rows.length === 0 && <Empty>{tab === 'active' ? 'ไม่มีสัญญาที่เช่าอยู่' : 'ยังไม่มีสัญญาที่คืนแล้ว'}</Empty>}
        <ul className={styles.list}>
          {rows.map((r) => (
            <li key={r.id} className={styles.row} data-overdue={r.overdue}>
              <Link href={`/rentals/${r.id}`} className={styles.main}>
                <span className={styles.who}>
                  <b>{r.customerName}</b>
                  <span className="muted">{r.hotelRoom ? `ห้อง ${r.hotelRoom}` : 'นอกโรงแรม'}</span>
                </span>
                <span className={styles.items}>{r.items.map((i) => i.label).join(' · ')}</span>
                <span className={styles.when}>
                  {r.status === 'active' ? (
                    r.overdue ? (
                      <span className="badge badge-danger">{overdueText(r.dueAt)}</span>
                    ) : (
                      <span className="badge badge-info">{dueText(r.dueAt)}</span>
                    )
                  ) : (
                    <span className="badge badge-ok">คืนแล้ว {r.returnedAt ? dateTimeText(r.returnedAt) : ''}</span>
                  )}
                </span>
              </Link>
              {r.status === 'active' && (
                <Link className={`btn ${r.overdue ? 'btn-primary' : ''} ${styles.returnBtn}`} href={`/rentals/${r.id}#return`}>
                  รับคืน
                </Link>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
