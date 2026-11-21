'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Segmented, Skeleton } from '@/components/motion';
import { useMe } from '@/components/shell';
import { Notice, PageHeader, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { BOOKING_STATUS_BADGE, BOOKING_STATUS_TH, type RenderedMessage, type StaffBooking } from '@/lib/api-p3';
import { baht, dateTimeText } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import styles from './bookings.module.css';

type Tab = 'requested' | 'confirmed' | 'all';
const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'requested', label: 'รอยืนยัน' },
  { value: 'confirmed', label: 'ยืนยันแล้ว' },
  { value: 'all', label: 'ทั้งหมด' },
];
const DAY_MS = 86_400_000;
const WEEKDAY = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const REJECT_PRESETS = ['รถเต็มช่วงนั้น', 'ไม่มีใบขับขี่', 'ข้อมูลติดต่อไม่ครบ', 'ร้านปิดวันนั้น'];

/** คำขอจอง (mock 3.05 / 3.W2 · จัดหน้า 8.W8) · ยืนยัน + กำหนดคัน · ปฏิเสธ · ไม่มารับ · ส่ง WhatsApp */
export default function BookingsPage() {
  const { me } = useMe();
  const [tab, setTab] = useState<Tab>('requested');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);
  const list = useLoad(() => api.get<StaffBooking[]>(`/v1/bookings${tab === 'all' ? '' : `?status=${tab}`}`).then((r) => r.data), [tab]);
  // แผงข้าง: ใช้รายการทั้งหมด (endpoint เดียวกัน) นับวันที่มีจองและสรุปสัปดาห์
  const all = useLoad(() => api.get<StaffBooking[]>('/v1/bookings').then((r) => r.data), []);
  const bookingUrl = typeof window === 'undefined' ? '' : `${window.location.origin}/book/${me.org.slug}`;

  function reloadAll() {
    void list.reload();
    void all.reload();
  }

  return (
    <div className={styles.page}>
      <PageHeader
        kicker="ลูกค้าจองจากหน้าจองของร้าน · ร้านยืนยันแล้วจึงกันรถ"
        title="การจอง"
        actions={
          <Link className="btn" href="/bookings/calendar">
            ปฏิทินรถ 14 วัน
          </Link>
        }
      />
      <Notice notice={notice} />
      {list.error && <Notice notice={{ kind: 'danger', text: list.error }} />}

      <div className="split">
        <div className="split-main">
          <Segmented<Tab> label="สถานะคำขอ" value={tab} onChange={setTab} options={TABS} />
          {!list.data && !list.error && <Skeleton h={220} />}
          {list.data && list.data.length === 0 && (
            <section className={`card ${styles.empty}`}>
              <span className={styles.emptyIcon} aria-hidden="true">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <rect x="3" y="5" width="18" height="16" rx="2" />
                  <path d="M3 10h18M8 3v4M16 3v4" />
                </svg>
              </span>
              <h2>{tab === 'requested' ? 'ยังไม่มีคำขอที่รอยืนยัน' : tab === 'confirmed' ? 'ยังไม่มีการจองที่ยืนยันแล้ว' : 'ยังไม่มีการจอง'}</h2>
              <p className="muted">คำขอใหม่จากหน้าจองจะขึ้นที่นี่ · แชร์ลิงก์หรือติดโปสเตอร์ QR ให้ลูกค้าจองได้เอง</p>
              <div className={styles.emptyActions}>
                <CopyLink url={bookingUrl} />
                <Link className="btn" href="/settings/poster">
                  พิมพ์โปสเตอร์ QR
                </Link>
              </div>
            </section>
          )}
          <div className={`${styles.list} motion-list`} key={tab}>
            {(list.data ?? []).map((b) => (
              <BookingCard
                key={b.id}
                booking={b}
                onChanged={(text) => {
                  setNotice({ kind: 'ok', text });
                  reloadAll();
                }}
                onError={(text) => setNotice({ kind: 'danger', text })}
              />
            ))}
          </div>
        </div>
        <aside className="split-side">
          <UpcomingCard bookings={all.data} />
          <WeekCard bookings={all.data} />
        </aside>
      </div>
    </div>
  );
}

function CopyLink({ url }: { url: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      onClick={() => {
        void navigator.clipboard?.writeText(url).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        });
      }}
    >
      {done ? 'คัดลอกแล้ว' : 'คัดลอกลิงก์หน้าจอง'}
    </button>
  );
}

const ACTIVE: StaffBooking['status'][] = ['requested', 'confirmed'];

/** 14 วันข้างหน้า: วันที่มีลูกค้ามารับรถ (รอยืนยัน/ยืนยันแล้ว) */
function UpcomingCard({ bookings }: { bookings: StaffBooking[] | null }) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => new Date(start.getTime() + i * DAY_MS));
  const count = new Map<string, number>();
  for (const b of bookings ?? []) {
    if (!ACTIVE.includes(b.status)) continue;
    const k = dayKey(new Date(b.pickupAt));
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const withBookings = days.filter((d) => count.has(dayKey(d))).length;
  return (
    <section className="card">
      <div className="card-head">
        <h2>14 วันข้างหน้า</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          {bookings ? `มีคนมารับรถ ${withBookings} วัน` : ''}
        </span>
      </div>
      <div className="card-body">
        {!bookings ? (
          <Skeleton h={96} />
        ) : (
          <div className={styles.mini} role="list" aria-label="วันที่มีการจอง">
            {days.map((d, i) => {
              const n = count.get(dayKey(d)) ?? 0;
              return (
                <span key={i} role="listitem" className={styles.miniDay} data-on={n > 0} data-today={i === 0} aria-label={`${d.getDate()} ${n ? `มีจอง ${n}` : 'ไม่มีจอง'}`}>
                  <small>{WEEKDAY[d.getDay()]}</small>
                  <b>{d.getDate()}</b>
                  {n > 0 && <i>{n}</i>}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

/** สัปดาห์นี้ (7 วันล่าสุดที่ลูกค้าส่งคำขอ) */
function WeekCard({ bookings }: { bookings: StaffBooking[] | null }) {
  const since = Date.now() - 7 * DAY_MS;
  const recent = (bookings ?? []).filter((b) => new Date(b.createdAt).getTime() >= since);
  const rows: Array<[string, number]> = [
    ['คำขอใหม่', recent.length],
    ['รอยืนยัน', recent.filter((b) => b.status === 'requested').length],
    ['ยืนยันแล้ว / รับรถแล้ว', recent.filter((b) => b.status === 'confirmed' || b.status === 'picked_up').length],
    ['ปฏิเสธ', recent.filter((b) => b.status === 'rejected').length],
    ['ลูกค้ายกเลิก / ไม่มารับ', recent.filter((b) => b.status === 'cancelled' || b.status === 'no_show').length],
  ];
  return (
    <section className="card">
      <div className="card-head">
        <h2>7 วันที่ผ่านมา</h2>
      </div>
      <div className="card-body">
        {!bookings ? (
          <Skeleton h={120} />
        ) : (
          <dl className={styles.week}>
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt className="muted">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}

function BookingCard({ booking: b, onChanged, onError }: { booking: StaffBooking; onChanged: (t: string) => void; onError: (t: string) => void }) {
  const unitItems = b.items.filter((i) => i.tracking === 'unit');
  // ค่าเริ่มต้น: เลือกคันที่แนะนำให้ไม่ซ้ำกัน
  const [assign, setAssign] = useState<Record<string, string>>(() => {
    const used = new Set<string>();
    const out: Record<string, string> = {};
    for (const it of unitItems) {
      const pick = (b.suggestions[it.assetTypeId] ?? []).find((x) => !used.has(x.id));
      if (pick) {
        out[it.id] = pick.id;
        used.add(pick.id);
      }
    }
    return out;
  });
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const digits = b.whatsapp.replace(/\D/g, '');

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      onChanged(ok);
    } catch (e) {
      onError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendWhatsApp(key: 'booking_confirmed' | 'booking_rejected') {
    try {
      const { data } = await api.post<RenderedMessage>(`/v1/message-templates/${key}/render`, { bookingId: b.id });
      window.open(data.waUrl, '_blank', 'noopener');
    } catch (e) {
      onError(messageFor(e));
    }
  }

  const picked = Object.values(assign);
  const duplicate = picked.length !== new Set(picked).size;
  const canConfirm = unitItems.every((i) => assign[i.id]) && !duplicate;

  return (
    <article className={`card ${styles.card}`} aria-labelledby={`bk-${b.id}`}>
      <header className={styles.head}>
        <div style={{ minWidth: 0 }}>
          <h2 id={`bk-${b.id}`}>
            {b.fullName} <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>· {b.code}</span>
          </h2>
          <p className="muted" style={{ fontSize: 13 }}>
            {b.hotelRoom ? `ห้อง ${b.hotelRoom}` : 'นอกโรงแรม'} · WhatsApp{' '}
            <a href={`https://wa.me/${digits}`} target="_blank" rel="noreferrer">
              {b.whatsapp}
            </a>
            {b.source ? ` · มาจาก ${b.source}` : ''}
          </p>
        </div>
        <span className={`badge ${BOOKING_STATUS_BADGE[b.status]}`}>{BOOKING_STATUS_TH[b.status]}</span>
      </header>

      <dl className={styles.facts}>
        <dt>รับรถ</dt>
        <dd>{dateTimeText(b.pickupAt)}</dd>
        <dt>คืน</dt>
        <dd>
          {dateTimeText(b.returnAt)} · {b.days} วัน
        </dd>
        <dt>ยอดประมาณ</dt>
        <dd>
          <b>{baht(b.total)}</b> <span className="muted">(จ่ายที่ร้าน)</span>
        </dd>
        {b.notes && (
          <>
            <dt>หมายเหตุ</dt>
            <dd>{b.notes}</dd>
          </>
        )}
        {b.rejectReason && (
          <>
            <dt>เหตุผลที่ปฏิเสธ</dt>
            <dd>{b.rejectReason}</dd>
          </>
        )}
      </dl>

      {b.warnings.length > 0 && b.status === 'requested' && (
        <ul className={styles.warnings} aria-label="ข้อควรระวัง">
          {b.warnings.map((w) => (
            <li key={w} className="badge badge-warn">
              {w}
            </li>
          ))}
        </ul>
      )}

      <ul className={styles.items}>
        {b.items.map((it) => (
          <li key={it.id}>
            <span>{it.label}</span>
            {b.status === 'requested' && it.tracking === 'unit' ? (
              <label className={styles.assign}>
                <span className="sr-only">เลือกคันให้ {it.label}</span>
                <select className="input" value={assign[it.id] ?? ''} onChange={(e) => setAssign((a) => ({ ...a, [it.id]: e.target.value }))}>
                  <option value="">— เลือกคัน —</option>
                  {(b.suggestions[it.assetTypeId] ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              it.assetCode && <span className="badge badge-info">{it.assetCode}</span>
            )}
          </li>
        ))}
      </ul>
      {duplicate && <div className="alert alert-warn">เลือกคันเดียวกันซ้ำ</div>}

      <div className={styles.actions}>
        {b.status === 'requested' && !rejecting && (
          <>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canConfirm || busy}
              onClick={() =>
                run(
                  () => api.post(`/v1/bookings/${b.id}/confirm`, { assignments: unitItems.map((i) => ({ itemId: i.id, assetId: assign[i.id]! })) }),
                  `ยืนยัน ${b.code} แล้ว · กดส่ง WhatsApp แจ้งลูกค้าได้ในแท็บ "ยืนยันแล้ว"`,
                )
              }
            >
              ยืนยันคำขอ
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setRejecting(true)}>
              ปฏิเสธ
            </button>
          </>
        )}
        {b.status === 'confirmed' && (
          <>
            <Link className="btn btn-primary" href={`/checkout?booking=${b.id}`}>
              เริ่มปล่อยเช่า
            </Link>
            <button type="button" className="btn" onClick={() => sendWhatsApp('booking_confirmed')}>
              ส่ง WhatsApp ยืนยัน
            </button>
            <NoShowButton disabled={busy} onConfirm={() => run(() => api.post(`/v1/bookings/${b.id}/no-show`), `${b.code}: ไม่มารับ · ปล่อยคันคืนแล้ว`)} />
          </>
        )}
        {b.status === 'rejected' && (
          <button type="button" className="btn" onClick={() => sendWhatsApp('booking_rejected')}>
            ส่ง WhatsApp แจ้งลูกค้า
          </button>
        )}
        {b.status === 'picked_up' && b.rentalId && (
          <Link className="btn" href={`/rentals/${b.rentalId}`}>
            เปิดสัญญา
          </Link>
        )}
      </div>

      {rejecting && (
        <div className={styles.reject}>
          <div className={styles.presets} role="group" aria-label="เหตุผลที่ใช้บ่อย">
            {REJECT_PRESETS.map((p) => (
              <button key={p} type="button" className="btn btn-sm" aria-pressed={reason === p} onClick={() => setReason(p)}>
                {p}
              </button>
            ))}
          </div>
          <label className="field">
            เหตุผล (ลูกค้าเห็นในลิงก์ของเขา)
            <input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className={styles.actions}>
            <button
              type="button"
              className="btn btn-danger"
              disabled={reason.trim().length < 2 || busy}
              onClick={() => run(() => api.post(`/v1/bookings/${b.id}/reject`, { reason: reason.trim() }), `ปฏิเสธ ${b.code} แล้ว · กดส่ง WhatsApp แจ้งลูกค้าได้`)}
            >
              ยืนยันปฏิเสธ
            </button>
            <button type="button" className="btn" onClick={() => setRejecting(false)}>
              ยกเลิก
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function NoShowButton({ onConfirm, disabled }: { onConfirm: () => void; disabled: boolean }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-danger"
      disabled={disabled}
      onClick={() => {
        if (armed) onConfirm();
        else {
          setArmed(true);
          setTimeout(() => setArmed(false), 4000);
        }
      }}
    >
      {armed ? 'ยืนยันว่าไม่มารับ?' : 'ไม่มารับ'}
    </button>
  );
}
