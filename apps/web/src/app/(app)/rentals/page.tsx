'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Segmented, Skeleton, useShowMore } from '@/components/motion';
import { Empty, Notice, PageHeader, useLoad } from '@/components/ui';
import { api, type RentalSummary } from '@/lib/api';
import { dateTimeText, dueText, overdueText } from '@/lib/format';
import styles from './rentals.module.css';

type Tab = 'active' | 'returned';

/** สัญญาที่เช่าอยู่ / คืนแล้ว · ทางลัดไปรับคืน */
export default function RentalsPage() {
  const [tab, setTab] = useState<Tab>('active');
  const list = useLoad(() => api.get<RentalSummary[]>(`/v1/rentals${tab === 'returned' ? '?status=returned' : ''}`).then((r) => r.data), [tab]);
  const [q, setQ] = useState('');
  const all = list.data ?? [];
  const needle = q.trim().toLowerCase();
  const rows = needle
    ? all.filter((r) => [r.customerName, r.hotelRoom, ...r.items.map((i) => i.label)].some((v) => v?.toLowerCase().includes(needle)))
    : all;
  const { visible, more } = useShowMore(rows, 20);
  const overdue = all.filter((r) => r.overdue).length;

  return (
    <div className={styles.page}>
      <PageHeader
        kicker={tab === 'active' ? `เช่าอยู่ ${all.length} · เลยกำหนด ${overdue}` : 'คืนแล้วล่าสุด'}
        title="สัญญา / รับคืน"
        actions={
          <Link className="btn btn-primary" href="/checkout" style={{ minHeight: 48 }}>
            + ปล่อยเช่า
          </Link>
        }
      />
      <Notice notice={list.error ? { kind: 'danger', text: list.error } : null} />

      <section className="card" aria-live="polite">
        <div className={styles.toolbar}>
          <Segmented<Tab>
            label="สถานะสัญญา"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'active', label: 'เช่าอยู่' },
              { value: 'returned', label: 'คืนแล้ว' },
            ]}
          />
          <input className={`input ${styles.search}`} type="search" placeholder="ค้นหาชื่อ ห้อง รหัสรถ" aria-label="ค้นหาสัญญา" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!list.data && !list.error && (
          <div className={styles.skel}>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} h={44} />
            ))}
          </div>
        )}
        {list.data && rows.length === 0 && <Empty>{needle ? 'ไม่พบสัญญาที่ค้นหา' : tab === 'active' ? 'ไม่มีสัญญาที่เช่าอยู่' : 'ยังไม่มีสัญญาที่คืนแล้ว'}</Empty>}
        <ul className={`${styles.list} motion-list`} key={tab}>
          {visible.map((r) => (
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
        {more}
      </section>
    </div>
  );
}
