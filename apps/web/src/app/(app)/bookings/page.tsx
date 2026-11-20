'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Empty, Notice, PageHeader, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { BOOKING_STATUS_BADGE, BOOKING_STATUS_TH, type RenderedMessage, type StaffBooking } from '@/lib/api-p3';
import { baht, dateTimeText } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import styles from './bookings.module.css';

type Tab = 'requested' | 'confirmed' | 'all';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'requested', label: 'รอยืนยัน' },
  { key: 'confirmed', label: 'ยืนยันแล้ว' },
  { key: 'all', label: 'ทั้งหมด' },
];
const REJECT_PRESETS = ['รถเต็มช่วงนั้น', 'ไม่มีใบขับขี่', 'ข้อมูลติดต่อไม่ครบ', 'ร้านปิดวันนั้น'];

/** คำขอจอง (mock 3.05 / 3.W2) · ยืนยัน + กำหนดคัน · ปฏิเสธ · ไม่มารับ · ส่ง WhatsApp */
export default function BookingsPage() {
  const [tab, setTab] = useState<Tab>('requested');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);
  const list = useLoad(() => api.get<StaffBooking[]>(`/v1/bookings${tab === 'all' ? '' : `?status=${tab}`}`).then((r) => r.data), [tab]);

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
      <div className={styles.tabs} role="tablist" aria-label="สถานะคำขอ">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={styles.tab} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <Notice notice={notice} />
      {list.error && <Notice notice={{ kind: 'danger', text: list.error }} />}
      {list.data && list.data.length === 0 && (
        <div className="card">
          <Empty>{tab === 'requested' ? 'ไม่มีคำขอรอยืนยัน' : 'ยังไม่มีรายการ'}</Empty>
        </div>
      )}
      <div className={styles.list}>
        {(list.data ?? []).map((b) => (
          <BookingCard
            key={b.id}
            booking={b}
            onChanged={(text) => {
              setNotice({ kind: 'ok', text });
              void list.reload();
            }}
            onError={(text) => setNotice({ kind: 'danger', text })}
          />
        ))}
      </div>
    </div>
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
