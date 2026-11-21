'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Skeleton } from '@/components/motion';
import { Empty, Notice, PageHeader, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import type { BookingCalendar, CalendarSegment } from '@/lib/api-p3';
import { dateTimeText } from '@/lib/format';
import styles from './calendar.module.css';

const KIND: Record<CalendarSegment['kind'], { label: string; cls: string }> = {
  rental: { label: 'เช่าอยู่', cls: styles.segRental! },
  rental_returned: { label: 'คืนแล้ว', cls: styles.segReturned! },
  booking: { label: 'จองแล้ว', cls: styles.segBooking! },
  maintenance: { label: 'ซ่อม', cls: styles.segMaintenance! },
};

function shift(ymd: string, days: number) {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ปฏิทินรถ 14 วัน (mock 3.W2) · แถว = รถแต่ละคัน · แถบสี = สัญญา / จอง / ซ่อม */
export default function BookingCalendarPage() {
  const [from, setFrom] = useState<string | null>(null);
  const cal = useLoad(() => api.get<BookingCalendar>(`/v1/bookings/calendar?days=14${from ? `&from=${from}` : ''}`).then((r) => r.data), [from]);
  const c = cal.data;

  const days = useMemo(() => {
    if (!c) return [];
    return Array.from({ length: c.days }, (_, i) => {
      const d = new Date(`${shift(c.from, i)}T12:00:00`);
      return { key: i, dow: d.toLocaleDateString('th-TH', { weekday: 'short' }), day: d.getDate(), weekend: d.getDay() === 0 || d.getDay() === 6 };
    });
  }, [c]);

  const start = c ? new Date(c.start).getTime() : 0;
  const span = c ? new Date(c.end).getTime() - start : 1;
  const nowPct = c ? ((Date.now() - start) / span) * 100 : -1;

  return (
    <div className={styles.page}>
      <PageHeader
        kicker={c ? `${c.from} · ${c.days} วัน` : 'ปฏิทินรถ'}
        title="ปฏิทินรถ"
        actions={
          <>
            <button type="button" className="btn" disabled={!c} onClick={() => c && setFrom(shift(c.from, -7))}>
              ‹ 7 วันก่อน
            </button>
            <button type="button" className="btn" onClick={() => setFrom(null)}>
              วันนี้
            </button>
            <button type="button" className="btn" disabled={!c} onClick={() => c && setFrom(shift(c.from, 7))}>
              7 วันถัดไป ›
            </button>
          </>
        }
      />
      {cal.error && <Notice notice={{ kind: 'danger', text: cal.error }} />}
      <div className={styles.legend}>
        {Object.entries(KIND).map(([k, v]) => (
          <span key={k}>
            <span className={`${styles.swatch} ${v.cls}`} /> {v.label}
          </span>
        ))}
      </div>

      <div className={styles.cols}>
        <section className="card" style={{ minWidth: 0 }}>
          {!c && !cal.error && (
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} h={32} />
              ))}
            </div>
          )}
          {c && c.assets.length === 0 && <Empty>ยังไม่มีรถรายคัน</Empty>}
          {c && c.assets.length > 0 && (
            <div className={styles.scroller}>
              <div className={styles.grid} style={{ ['--days' as string]: c.days }}>
                <div className={`${styles.rowHead} ${styles.corner}`}>รถ</div>
                <div className={styles.dayHead}>
                  {days.map((d) => (
                    <span key={d.key} className={d.weekend ? styles.weekend : undefined}>
                      <small>{d.dow}</small>
                      {d.day}
                    </span>
                  ))}
                </div>
                {c.assets.map((a) => (
                  <div key={a.id} className={styles.row}>
                    <div className={styles.rowHead}>
                      <b>{a.code}</b>
                      <small className="muted">{a.typeName}</small>
                    </div>
                    <div className={styles.track}>
                      {nowPct >= 0 && nowPct <= 100 && <span className={styles.now} style={{ left: `${nowPct}%` }} aria-hidden="true" />}
                      {a.segments.map((g, i) => {
                        const s = Math.max(0, new Date(g.start).getTime() - start);
                        const e = Math.min(span, new Date(g.end).getTime() - start);
                        if (e <= 0 || s >= span) return null;
                        const text = `${KIND[g.kind].label}${g.overdue ? ' · เลยกำหนด' : ''} · ${g.label} · ${dateTimeText(g.start)} → ${dateTimeText(g.end)}`;
                        const style = { left: `${(s / span) * 100}%`, width: `${Math.max(1.5, ((e - s) / span) * 100)}%` };
                        const cls = `${styles.seg} ${KIND[g.kind].cls} ${g.overdue ? styles.segOverdue : ''}`;
                        const href = g.kind === 'booking' ? '/bookings' : g.refId ? `/rentals/${g.refId}` : null;
                        return href ? (
                          <Link key={i} href={href} className={cls} style={style} title={text} aria-label={text}>
                            {g.label}
                          </Link>
                        ) : (
                          <span key={i} className={cls} style={style} title={text}>
                            {g.label}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <aside className={`card ${styles.side}`} aria-label="คำขอรอยืนยัน">
          <div className="card-head">
            <h2>รอยืนยัน</h2>
            <span className="badge badge-warn">{c?.requests.length ?? 0}</span>
          </div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {c && c.requests.length === 0 && <span className="muted">ไม่มีคำขอใหม่</span>}
            {c?.requests.map((r) => (
              <Link key={r.id} href="/bookings" className={`${styles.request} motion-lift`}>
                <b>
                  {r.code} · {r.fullName}
                </b>
                <span className="muted">
                  {r.items.map((i) => i.label).join(', ')} · {dateTimeText(r.pickupAt)} · {r.days} วัน
                </span>
              </Link>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
