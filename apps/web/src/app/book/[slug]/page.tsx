'use client';

import { AssetImage, visualKind } from '@/components/asset-visual';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { thb, type PublicShop } from '@/lib/api-p3';
import { publicMessage } from '@/lib/messages-p3';
import { PublicFrame } from '../public-frame';
import styles from '../public.module.css';

interface CalendarDay {
  date: string;
  pickupAt: string;
  past: boolean;
  types: Array<{ id: string; available: number; variants?: Array<{ id: string; available: number }> }>;
}

const HOURS = Array.from({ length: 12 }, (_, i) => 8 + i); // 08:00–19:00
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** หน้าจองของลูกค้า (mock 3.01 + 3.02 + 3.W1) · ไม่ต้องสมัคร ไม่จ่ายออนไลน์ */
export default function BookPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const startedAt = useRef(Date.now());
  const [shop, setShop] = useState<PublicShop | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // key = typeId (รายชิ้น) หรือ variantId (นับจำนวน)
  const [qty, setQty] = useState<Record<string, number>>({});
  const [days, setDays] = useState(3);
  const [hour, setHour] = useState(10);
  const [pickupDate, setPickupDate] = useState<string | null>(null);
  const [calendar, setCalendar] = useState<CalendarDay[]>([]);
  const [calFrom, setCalFrom] = useState(() => ymd(new Date()));
  const [form, setForm] = useState({ fullName: '', whatsapp: '', email: '', hotel: 'yes', hotelRoom: '', checkoutDate: '', hasLicense: false, notes: '', website: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<PublicShop>(`/v1/public/shops/${encodeURIComponent(slug)}`)
      .then(({ data }) => setShop(data))
      .catch((e) => setLoadError(publicMessage(e)));
  }, [slug]);

  const maxDays = Math.min(shop?.maxRentalDays ?? 30, 30);

  // ความว่างรายวันของ 28 วัน (คำขอเดียว) · คำนวณใหม่เมื่อเปลี่ยนจำนวนวันหรือเวลารับ
  useEffect(() => {
    if (!shop) return;
    const t = setTimeout(() => {
      api
        .get<{ days: CalendarDay[] }>(`/v1/public/shops/${encodeURIComponent(slug)}/calendar?from=${calFrom}&span=${days}&count=28&hour=${hour}`)
        .then(({ data }) => setCalendar(data.days))
        .catch(() => setCalendar([]));
    }, 250);
    return () => clearTimeout(t);
  }, [shop, slug, calFrom, days, hour]);

  const lines = useMemo(() => {
    if (!shop) return [];
    const out: Array<{ key: string; typeId: string; variantId?: string; label: string; n: number; amount: number }> = [];
    for (const t of shop.types) {
      if (t.tracking === 'unit') {
        const n = qty[t.id] ?? 0;
        if (n > 0) out.push({ key: t.id, typeId: t.id, label: t.name, n, amount: t.pricePerDay * n * days });
      } else {
        for (const v of t.variants) {
          const n = qty[v.id] ?? 0;
          if (n > 0) out.push({ key: v.id, typeId: t.id, variantId: v.id, label: `${t.name} (${v.label})`, n, amount: t.pricePerDay * n * days });
        }
      }
    }
    return out;
  }, [shop, qty, days]);
  const total = lines.reduce((s, l) => s + l.amount, 0);

  /** วันนี้รับได้ไหม: ทุกอย่างที่เลือกต้องว่างพอตลอดช่วง */
  function dayOk(d: CalendarDay) {
    if (d.past) return false;
    if (!lines.length) return d.types.some((t) => t.available > 0);
    return lines.every((l) => {
      const t = d.types.find((x) => x.id === l.typeId);
      if (!t) return false;
      if (l.variantId) return (t.variants?.find((v) => v.id === l.variantId)?.available ?? 0) >= l.n;
      return t.available >= l.n;
    });
  }

  const pickedDay = calendar.find((d) => d.date === pickupDate);
  // เปลี่ยนสิ่งที่เลือกแล้ววันเดิมไม่ว่าง → ล้างวัน
  useEffect(() => {
    if (pickedDay && !dayOk(pickedDay)) setPickupDate(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendar, lines]);

  const returnDate = pickupDate ? new Date(new Date(`${pickupDate}T${String(hour).padStart(2, '0')}:00:00`).getTime() + days * 86_400_000) : null;
  const detailsOk = form.fullName.trim().length >= 2 && /^\+?[0-9 ()-]{8,20}$/.test(form.whatsapp.trim()) && form.hasLicense && (form.hotel === 'no' || form.hotelRoom.trim().length > 0);
  const ready = !!shop && lines.length > 0 && !!pickedDay && detailsOk && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || !pickedDay) return;
    setBusy(true);
    setError(null);
    try {
      const src = new URLSearchParams(window.location.search).get('src') ?? undefined;
      const { data } = await api.post<{ code: string; manageToken: string }>(`/v1/public/shops/${encodeURIComponent(slug)}/bookings`, {
        fullName: form.fullName.trim(),
        whatsapp: form.whatsapp.trim(),
        email: form.email.trim(),
        hotelRoom: form.hotel === 'yes' ? form.hotelRoom.trim() : undefined,
        checkoutDate: form.hotel === 'yes' && form.checkoutDate ? form.checkoutDate : undefined,
        hasLicense: form.hasLicense,
        pickupAt: pickedDay.pickupAt,
        days,
        notes: form.notes.trim() || undefined,
        source: src?.slice(0, 40),
        items: lines.map((l) => ({ typeId: l.typeId, ...(l.variantId ? { variantId: l.variantId } : {}), quantity: l.n })),
        website: form.website,
        startedAt: startedAt.current,
      });
      router.push(`/book/${encodeURIComponent(slug)}/done?code=${encodeURIComponent(data.code)}&t=${encodeURIComponent(data.manageToken)}`);
    } catch (err) {
      setError(publicMessage(err));
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <PublicFrame>
        <div className={`${styles.note} ${styles.noteRed}`} role="alert">{loadError}</div>
      </PublicFrame>
    );
  }
  if (!shop) return <PublicFrame>Loading…</PublicFrame>;

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const firstDow = calendar[0] ? (new Date(`${calendar[0].date}T12:00:00`).getDay() + 6) % 7 : 0;

  return (
    <PublicFrame shopName={shop.name}>
      <div className={styles.hero}>
        <h1>Book a scooter, ATV or gear</h1>
        <p>No account needed · No online payment, you pay at the shop · The shop confirms on WhatsApp</p>
      </div>

      <form className={styles.cols} onSubmit={submit}>
        <div className={styles.main}>
          <section className={styles.card} aria-labelledby="s1">
            <h2 id="s1"><span className={styles.step}>1</span>What would you like?</h2>
            {shop.types.map((t) =>
              t.tracking === 'unit' ? (
                <div key={t.id} className={styles.typeRow}>
                  <TypeThumb t={t} />
                  <div className={styles.typeName}>
                    <b>{t.name}</b>
                    <div className="muted">{thb(t.pricePerDay)} / day</div>
                  </div>
                  <Counter label={t.name} value={qty[t.id] ?? 0} max={5} onChange={(n) => setQty((q) => ({ ...q, [t.id]: n }))} />
                </div>
              ) : (
                t.variants.map((v) => (
                  <div key={v.id} className={styles.typeRow}>
                    <TypeThumb t={t} />
                    <div className={styles.typeName}>
                      <b>{t.name}</b> <span className="muted">size {v.label}</span>
                      <div className="muted">{thb(t.pricePerDay)} / day</div>
                    </div>
                    <Counter label={`${t.name} ${v.label}`} value={qty[v.id] ?? 0} max={10} onChange={(n) => setQty((q) => ({ ...q, [v.id]: n }))} />
                  </div>
                ))
              ),
            )}
          </section>

          <section className={styles.card} aria-labelledby="s2">
            <h2 id="s2"><span className={styles.step}>2</span>When?</h2>
            <div className={styles.row2}>
              <label className={styles.field}>
                Pickup time
                <select className={styles.input} value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                  {HOURS.map((h) => (
                    <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                  ))}
                </select>
              </label>
              <div className={styles.field}>
                Number of days
                <Counter label="days" value={days} min={1} max={maxDays} onChange={setDays} />
              </div>
            </div>
            <div className={styles.calHead}>
              <b>Pickup date</b>
              <span style={{ display: 'flex', gap: 6 }}>
                <button type="button" className={styles.ghost} aria-label="Previous weeks" disabled={calFrom <= ymd(new Date())}
                  onClick={() => setCalFrom((f) => { const d = new Date(`${f}T12:00:00`); d.setDate(d.getDate() - 28); return ymd(d) < ymd(new Date()) ? ymd(new Date()) : ymd(d); })}>‹</button>
                <button type="button" className={styles.ghost} aria-label="Next weeks"
                  onClick={() => setCalFrom((f) => { const d = new Date(`${f}T12:00:00`); d.setDate(d.getDate() + 28); return ymd(d); })}>›</button>
              </span>
            </div>
            <div className={styles.calGrid} role="group" aria-label="Pickup date">
              {WEEKDAYS.map((w) => (
                <span key={w} className={styles.dow}>{w}</span>
              ))}
              {Array.from({ length: firstDow }, (_, i) => <span key={`pad${i}`} />)}
              {calendar.map((d) => {
                const ok = dayOk(d);
                const dt = new Date(`${d.date}T12:00:00`);
                const inRange = pickupDate && d.date > pickupDate && returnDate && dt < returnDate;
                return (
                  <button key={d.date} type="button" className={`${styles.day} ${inRange ? styles.inRange : ''}`} disabled={!ok}
                    aria-pressed={pickupDate === d.date} aria-label={`${dt.toDateString()}${ok ? '' : ' (full)'}`} onClick={() => setPickupDate(d.date)}>
                    {dt.getDate()}
                    <small>{dt.getDate() === 1 || d === calendar[0] ? dt.toLocaleDateString('en-GB', { month: 'short' }) : ok ? '' : 'full'}</small>
                  </button>
                );
              })}
            </div>
            <span className="muted" style={{ fontSize: 13 }}>Greyed-out days are fully booked for your choice.</span>
          </section>

          <section className={styles.card} aria-labelledby="s3">
            <h2 id="s3"><span className={styles.step}>3</span>Your details</h2>
            <label className={styles.field}>
              Full name <small>as in your passport</small>
              <input className={styles.input} autoComplete="name" required value={form.fullName} onChange={set('fullName')} />
            </label>
            <label className={styles.field}>
              WhatsApp number <small>with country code, e.g. +49 170 1234567</small>
              <input className={styles.input} inputMode="tel" autoComplete="tel" required value={form.whatsapp} onChange={set('whatsapp')} placeholder="+" />
            </label>
            <label className={styles.field}>
              Email <small>optional</small>
              <input className={styles.input} type="email" autoComplete="email" value={form.email} onChange={set('email')} />
            </label>
            <fieldset className={styles.field} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ marginBottom: 6 }}>Are you staying at the hotel?</legend>
              <div className={styles.seg}>
                <label><input type="radio" name="hotel" value="yes" checked={form.hotel === 'yes'} onChange={set('hotel')} /> Yes</label>
                <label><input type="radio" name="hotel" value="no" checked={form.hotel === 'no'} onChange={set('hotel')} /> No</label>
              </div>
            </fieldset>
            {form.hotel === 'yes' && (
              <div className={styles.row2}>
                <label className={styles.field}>
                  Room number
                  <input className={styles.input} maxLength={10} value={form.hotelRoom} onChange={set('hotelRoom')} />
                </label>
                <label className={styles.field}>
                  Hotel check-out date <small>optional</small>
                  <input className={styles.input} type="date" value={form.checkoutDate} onChange={set('checkoutDate')} />
                </label>
              </div>
            )}
            <label className={styles.field}>
              Anything we should know? <small>optional</small>
              <input className={styles.input} maxLength={500} value={form.notes} onChange={set('notes')} />
            </label>
            <label className={styles.check}>
              <input type="checkbox" checked={form.hasLicense} onChange={(e) => setForm((f) => ({ ...f, hasLicense: e.target.checked }))} />
              I have a valid driving licence for this vehicle and will bring it with my passport.
            </label>
            {/* กับดัก bot: คนมองไม่เห็นช่องนี้ */}
            <div className={styles.honeypot} aria-hidden="true">
              <label>
                Website
                <input tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} />
              </label>
            </div>
          </section>

          <section className={`${styles.card} ${styles.faq}`} aria-labelledby="faq">
            <h2 id="faq">Questions</h2>
            <details><summary>Do I need a driving licence?</summary><p>Yes. Please bring a valid licence for the vehicle type and your passport. The shop checks both at pickup.</p></details>
            <details><summary>Do I pay now?</summary><p>No. There is no online payment. You pay at the shop (cash or transfer). Hotel guests can usually settle at hotel check-out.</p></details>
            <details><summary>Are helmets included?</summary><p>Helmets come with scooters and ATVs at no extra cost.</p></details>
            <details><summary>Can I change or cancel?</summary><p>Yes. You get a private link to view or cancel your booking until 2 hours before pickup. For changes, message the shop on WhatsApp.</p></details>
          </section>
        </div>

        <aside className={styles.aside} aria-label="Booking summary">
          <section className={styles.card}>
            <h2>Your booking</h2>
            {lines.length === 0 ? (
              <span className="muted">Choose a vehicle or gear to see the price.</span>
            ) : (
              lines.map((l) => (
                <div key={l.key} className={styles.summaryLine}>
                  <span>{l.label} × {l.n} · {days} {days === 1 ? 'day' : 'days'}</span>
                  <b>{thb(l.amount)}</b>
                </div>
              ))
            )}
            <div className={styles.summaryLine}>
              <span className="muted">Pickup</span>
              <span>{pickedDay ? new Date(pickedDay.pickupAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Choose a date'}</span>
            </div>
            {returnDate && (
              <div className={styles.summaryLine}>
                <span className="muted">Return</span>
                <span>{returnDate.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            )}
            <div className={styles.total}>
              <span>Total</span>
              <b>{thb(total)}</b>
            </div>
            <div className={`${styles.note} ${styles.noteGreen}`}>No online payment. Pay at the shop.</div>
            {error && <div className={`${styles.note} ${styles.noteRed}`} role="alert">{error}</div>}
            <button className={styles.primary} disabled={!ready}>{busy ? 'Sending…' : 'Send booking request'}</button>
            {!ready && !busy && (
              <span className="muted" style={{ fontSize: 13 }}>
                {lines.length === 0 ? 'Choose what you want to rent.' : !pickedDay ? 'Choose a pickup date.' : 'Fill in your details and confirm your licence.'}
              </span>
            )}
          </section>
        </aside>
      </form>
    </PublicFrame>
  );
}

function Counter({ label, value, min = 0, max, onChange }: { label: string; value: number; min?: number; max: number; onChange: (n: number) => void }) {
  return (
    <div className={styles.counter} role="group" aria-label={label}>
      <button type="button" aria-label={`Fewer ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
      <output aria-live="polite">{value}</output>
      <button type="button" aria-label={`More ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}

/** รูปประเภท (หน้าปกที่ร้านตั้ง) · ไม่มีรูป = ภาพวาดแทน (mock 9.W4) */
function TypeThumb({ t }: { t: PublicShop['types'][number] }) {
  return (
    <span className={styles.thumb}>
      <AssetImage src={t.coverUrl ? `/api${t.coverUrl}` : null} kind={visualKind(t.name, t.tracking)} alt={t.name} ratio={1} />
    </span>
  );
}
