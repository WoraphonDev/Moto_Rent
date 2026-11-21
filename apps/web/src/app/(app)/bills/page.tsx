'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Segmented, Skeleton, useShowMore } from '@/components/motion';
import { Empty, Notice, PageHeader, useLoad } from '@/components/ui';
import { api, type BillSummary } from '@/lib/api';
import { baht, dateTimeText, dateText } from '@/lib/format';
import styles from './bills.module.css';

type Tab = 'open' | 'paid';

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** บิลค้างจ่าย / จ่ายแล้ว (mock 1.07 / 1.W4) · หนึ่งบิลต่อลูกค้า รวมทุกสัญญา */
export default function BillsPage() {
  const [tab, setTab] = useState<Tab>('open');
  const list = useLoad(() => api.get<BillSummary[]>(`/v1/bills${tab === 'paid' ? '?status=paid' : ''}`).then((r) => r.data), [tab]);
  const [q, setQ] = useState('');
  const all = list.data ?? [];
  const needle = q.trim().toLowerCase();
  const rows = needle
    ? all.filter((b) => [b.customerName, b.hotelRoom, b.receiptNo].some((v) => v?.toLowerCase().includes(needle)))
    : all;
  const { visible, more } = useShowMore(rows, 20);
  const today = localToday();
  const outstanding = all.reduce((s, b) => s + (b.status === 'open' ? b.balance : 0), 0);

  return (
    <div className={styles.page}>
      <PageHeader kicker={tab === 'open' ? `ค้างทั้งหมด ${baht(outstanding)} · ${all.length} บิล` : 'จ่ายแล้วล่าสุด'} title="บิล" />
      <Notice notice={list.error ? { kind: 'danger', text: list.error } : null} />

      <section className="card" aria-live="polite">
        <div className={styles.toolbar}>
          <Segmented<Tab>
            label="สถานะบิล"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'open', label: 'ค้างจ่าย' },
              { value: 'paid', label: 'จ่ายแล้ว' },
            ]}
          />
          <input className={`input ${styles.search}`} type="search" placeholder="ค้นหาชื่อ ห้อง เลขใบเสร็จ" aria-label="ค้นหาบิล" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!list.data && !list.error && (
          <div className={styles.skel}>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} h={44} />
            ))}
          </div>
        )}
        {list.data && rows.length === 0 && <Empty>{needle ? 'ไม่พบบิลที่ค้นหา' : tab === 'open' ? 'ไม่มีบิลค้างจ่าย' : 'ยังไม่มีบิลที่จ่ายแล้ว'}</Empty>}
        <ul className={`${styles.list} motion-list`} key={tab}>
          {visible.map((b) => {
            const checkoutDue = b.status === 'open' && !!b.checkoutDate && b.checkoutDate <= today && b.balance > 0;
            return (
              <li key={b.id}>
                <Link href={`/bills/${b.id}`} className={styles.row} data-urgent={checkoutDue}>
                  <span className={styles.room}>{b.hotelRoom ?? '—'}</span>
                  <span className={styles.who}>
                    <b>{b.customerName}</b>
                    <span className="muted">
                      {b.status === 'paid'
                        ? `${b.receiptNo ?? ''} · ${b.paidAt ? dateTimeText(b.paidAt) : ''}`
                        : b.checkoutDate
                          ? `เช็คเอาท์ ${dateText(b.checkoutDate)}`
                          : b.hotelRoom
                            ? 'ยังไม่ระบุวันเช็คเอาท์'
                            : 'นอกโรงแรม'}
                    </span>
                  </span>
                  <span className={styles.status}>
                    {checkoutDue && <span className="badge badge-warn">เช็คเอาท์วันนี้</span>}
                    {b.status === 'paid' && <span className="badge badge-ok">จ่ายแล้ว</span>}
                  </span>
                  <span className={styles.amount}>
                    <b>{baht(b.status === 'open' ? b.balance : b.total)}</b>
                    <span className="muted">{b.status === 'open' ? (b.balance === b.total ? 'ค้าง' : `ค้าง จาก ${baht(b.total)}`) : 'รวม'}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        {more}
      </section>
    </div>
  );
}
