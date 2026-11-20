'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { thb, type PublicBooking } from '@/lib/api-p3';
import { publicMessage } from '@/lib/messages-p3';
import { PublicFrame } from '../../book/public-frame';
import styles from '../../book/public.module.css';

const STEPS: Array<{ key: string; label: string }> = [
  { key: 'requested', label: 'Request sent' },
  { key: 'confirmed', label: 'Confirmed by shop' },
  { key: 'picked_up', label: 'Picked up' },
];

/** ลูกค้าดู/ยกเลิกการจองผ่านลิงก์ส่วนตัว (mock 3.04) */
export default function ManageBookingPage() {
  const { token } = useParams<{ token: string }>();
  const [b, setB] = useState<PublicBooking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<PublicBooking>(`/v1/public/bookings/${encodeURIComponent(token)}`)
      .then(({ data }) => setB(data))
      .catch((e) => setError(publicMessage(e)));
  }, [token]);

  async function cancel() {
    if (!armed) return setArmed(true);
    setBusy(true);
    try {
      const { data } = await api.post<PublicBooking>(`/v1/public/bookings/${encodeURIComponent(token)}/cancel`);
      setB(data);
      setArmed(false);
    } catch (e) {
      setError(publicMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (error && !b) {
    return (
      <PublicFrame>
        <div className={`${styles.note} ${styles.noteRed}`} role="alert">{error}</div>
      </PublicFrame>
    );
  }
  if (!b) return <PublicFrame>Loading…</PublicFrame>;

  const stepIndex = STEPS.findIndex((s) => s.key === b.status);
  const ended = ['rejected', 'cancelled', 'no_show'].includes(b.status);
  const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: b.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const returnAt = new Date(new Date(b.pickupAt).getTime() + b.days * 86_400_000).toISOString();

  return (
    <PublicFrame shopName={b.shopName}>
      <section className={styles.nowCard}>
        <span className={styles.nowLabel}>Booking {b.code}</span>
        <h1 style={{ fontSize: 24 }}>{b.fullName}</h1>
        <span>{fmt(b.pickupAt)} → {fmt(returnAt)}</span>
      </section>

      {ended ? (
        <div className={`${styles.note} ${b.status === 'cancelled' ? styles.noteYellow : styles.noteRed}`} role="status">
          {b.status === 'cancelled' && 'This booking was cancelled.'}
          {b.status === 'rejected' && `Sorry, the shop could not confirm this booking.${b.rejectReason ? ` Reason: ${b.rejectReason}` : ''} Please message the shop for other dates.`}
          {b.status === 'no_show' && 'This booking expired because the vehicle was not picked up.'}
        </div>
      ) : (
        <ol className={styles.steps} aria-label="Booking status">
          {STEPS.map((s, i) => (
            <li key={s.key} data-done={i <= stepIndex}>{s.label}</li>
          ))}
        </ol>
      )}

      <section className={styles.card}>
        <h2>Details</h2>
        <dl className={styles.kv}>
          <dt>WhatsApp</dt>
          <dd>{b.whatsappMasked}</dd>
          {b.hotelRoom && (
            <>
              <dt>Room</dt>
              <dd>{b.hotelRoom}</dd>
            </>
          )}
          <dt>Days</dt>
          <dd>{b.days}</dd>
        </dl>
        {b.items.map((it, i) => (
          <div key={i} className={styles.summaryLine}>
            <span>{it.typeName}{it.variantLabel ? ` (${it.variantLabel})` : ''} × {it.quantity}</span>
            <b>{thb(it.pricePerDay * it.quantity * b.days)}</b>
          </div>
        ))}
        <div className={styles.total}>
          <span>Total (pay at the shop)</span>
          <b>{thb(b.total)}</b>
        </div>
      </section>

      {!ended && b.status !== 'picked_up' && (
        <section className={styles.card}>
          <h2>Cancel</h2>
          {b.cancellable ? (
            <>
              <span className="muted">You can cancel online until {b.cancelWindowHours} hours before pickup.</span>
              {error && <div className={`${styles.note} ${styles.noteRed}`} role="alert">{error}</div>}
              <button type="button" className={styles.ghost} style={{ color: 'var(--danger-text)', borderColor: 'var(--danger-line)' }} disabled={busy} onClick={cancel}>
                {armed ? 'Tap again to cancel this booking' : 'Cancel booking'}
              </button>
            </>
          ) : (
            <span className="muted">Pickup is less than {b.cancelWindowHours} hours away. Please message the shop on WhatsApp to change or cancel.</span>
          )}
        </section>
      )}
    </PublicFrame>
  );
}
