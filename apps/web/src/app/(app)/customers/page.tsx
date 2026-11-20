'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Empty, Notice, PageHeader, useLoad } from '@/components/ui';
import { api, type CustomerSummary } from '@/lib/api';
import { baht } from '@/lib/format';
import { CustomerForm, emptyCustomer, toPayload } from './customer-form';
import styles from './customers.module.css';

/** ลูกค้า (mock 1.10 / 1.W6) */
export default function CustomersPage() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [adding, setAdding] = useState(false);

  // ค้นหลังหยุดพิมพ์ 300 ms
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const list = useLoad(() => api.get<CustomerSummary[]>(`/v1/customers${term ? `?q=${encodeURIComponent(term)}` : ''}`).then((r) => r.data), [term]);

  return (
    <div className={styles.page}>
      <PageHeader
        kicker="ค้นจากชื่อ เลขห้อง หรือเบอร์"
        title="ลูกค้า"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
            {adding ? 'ปิดฟอร์ม' : '+ เพิ่มลูกค้า'}
          </button>
        }
      />

      {adding && (
        <section className="card">
          <div className="card-head">
            <h2>ลูกค้าใหม่</h2>
          </div>
          <div className="card-body">
            <CustomerForm
              initial={emptyCustomer}
              submitLabel="บันทึกลูกค้า"
              onSubmit={async (v) => {
                const { data } = await api.post<{ id: string }>('/v1/customers', toPayload(v));
                router.push(`/customers/${data.id}`);
              }}
            />
          </div>
        </section>
      )}

      <label className={styles.search}>
        <span className="sr-only">ค้นหาลูกค้า</span>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input className="input" type="search" placeholder="เช่น Emma, 204, +45…" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>

      <Notice notice={list.error ? { kind: 'danger', text: list.error } : null} />

      <section className="card">
        <div className="card-head">
          <h2>{term ? `ผลการค้น “${term}”` : 'ลูกค้าล่าสุด'}</h2>
          <span className="muted" style={{ fontSize: 13 }}>{list.data ? `${list.data.length} คน` : ''}</span>
        </div>
        {list.data && list.data.length === 0 ? (
          <Empty>{term ? 'ไม่พบลูกค้า · เพิ่มเป็นลูกค้าใหม่ได้' : 'ยังไม่มีลูกค้า'}</Empty>
        ) : (
          <ul className={styles.list}>
            {(list.data ?? []).map((c) => (
              <li key={c.id}>
                <Link href={`/customers/${c.id}`} className={styles.row}>
                  <span className="avatar" aria-hidden="true">
                    {c.fullName.trim().slice(0, 2).toUpperCase()}
                  </span>
                  <span className={styles.main}>
                    <b>{c.fullName}</b>
                    <span className="muted">
                      {[c.hotelRoom ? `ห้อง ${c.hotelRoom}` : 'ไม่ได้พักโรงแรม', c.nationality, c.phone].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className={styles.badges}>
                    {c.doNotRent && <span className="badge badge-danger">ไม่ให้เช่า</span>}
                    {c.balance > 0 ? <span className="badge badge-warn">ค้าง {baht(c.balance)}</span> : <span className="badge badge-neutral">ไม่มียอดค้าง</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
