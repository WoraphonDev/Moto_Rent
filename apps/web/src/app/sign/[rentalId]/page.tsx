'use client';

import { AssetImage, visualKind } from '@/components/asset-visual';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { api, ApiError, type Me } from '@/lib/api';
import { mediaUrl, uploadForm, type Media, type RentalWithSign } from '@/lib/api-p1';
import { baht } from '@/lib/format';
import styles from './sign.module.css';

const SLOT_LABEL: Record<string, string> = { front: 'Front', back: 'Back', left: 'Left side', right: 'Right side', odometer: 'Odometer', fuel: 'Fuel gauge' };

const AGREEMENTS = [
  'I hold a valid driving licence for this type of vehicle.',
  'I will wear a helmet at all times and follow Thai traffic law.',
  'I am responsible for damage, loss, theft and traffic fines during the rental.',
  'I understand the return time, and that late returns and missing fuel are charged.',
] as const;

const ERROR_EN: Record<string, string> = {
  already_signed: 'This agreement has already been signed.',
  rental_closed: 'This rental is no longer active.',
  signature_required: 'Please sign in the box.',
  network_error: 'No connection. Please try again.',
  wrong_password: 'Wrong password.',
  rate_limited: 'Too many attempts. Please wait a moment.',
};

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * ลูกค้าเซ็นสัญญาบนเครื่องของร้าน (mock 1.05) · ภาษาอังกฤษ
 * หน้านี้ล็อกไว้: ไม่มีเมนู กดย้อนกลับไม่ได้ ออกได้เมื่อพนักงานใส่รหัสผ่านของตัวเองเท่านั้น
 */
export default function SignPage() {
  const { rentalId } = useParams<{ rentalId: string }>();
  const router = useRouter();
  const [rental, setRental] = useState<RentalWithSign | null>(null);
  const [shop, setShop] = useState('');
  const [photos, setPhotos] = useState<Media[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checks, setChecks] = useState<boolean[]>(AGREEMENTS.map(() => false));
  const [name, setName] = useState('');
  const [hasInk, setHasInk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    (async () => {
      try {
        // ล็อก session นี้ไว้กับสัญญานี้ที่เซิร์ฟเวอร์ก่อนยื่นเครื่องให้ลูกค้า (ออกได้ด้วยรหัสพนักงานเท่านั้น)
        await api.post(`/v1/rentals/${encodeURIComponent(rentalId)}/customer-mode`);
        const [r, me, m] = await Promise.all([
          api.get<RentalWithSign>(`/v1/rentals/${encodeURIComponent(rentalId)}`),
          api.get<Me>('/v1/auth/me'),
          api.get<Media[]>(`/v1/media?rentalId=${encodeURIComponent(rentalId)}`),
        ]);
        setRental(r.data);
        setName(r.data.customer.fullName);
        setShop(me.data.org.name);
        setPhotos(m.data.filter((x) => x.kind === 'vehicle_photo' && x.stage === 'checkout'));
      } catch (e) {
        setLoadError(e instanceof ApiError && e.status === 401 ? 'Staff must sign in on this device first.' : 'Could not load this agreement.');
      }
    })();
  }, [rentalId]);

  // ล็อกหน้าจอ: ปุ่มย้อนกลับของเบราว์เซอร์/มือถือไม่พาออกจากหน้านี้
  useEffect(() => {
    history.pushState(null, '', location.href);
    const stay = () => history.pushState(null, '', location.href);
    window.addEventListener('popstate', stay);
    return () => window.removeEventListener('popstate', stay);
  }, []);

  const ready = checks.every(Boolean) && name.trim().length >= 2 && hasInk && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || !canvasRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await new Promise<Blob>((ok, fail) => canvasRef.current!.toBlob((b) => (b ? ok(b) : fail(new Error())), 'image/png'));
      const form = new FormData();
      form.append('signerName', name.trim());
      form.append('accepted', 'true');
      form.append('signature', blob, 'signature.png');
      await uploadForm(`/v1/rentals/${encodeURIComponent(rentalId)}/sign`, form);
      setDone(true);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(err instanceof ApiError ? (ERROR_EN[err.code] ?? `Something went wrong (${err.code}).`) : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const exit = () => router.replace(`/rentals/${rentalId}`);

  return (
    <main className={styles.page}>
      <header className={styles.top}>
        <span className={styles.brand}>
          <span className="sun" aria-hidden="true" />
          {shop || 'Rental'}
        </span>
        <button type="button" className={styles.staffBtn} onClick={() => setExitOpen(true)}>
          Staff: exit
        </button>
      </header>

      {loadError && <div className={`${styles.card} ${styles.notice}`}>{loadError}</div>}

      {rental && done && (
        <section className={`${styles.card} ${styles.thanks}`} aria-live="polite">
          <span className={styles.sunBig} aria-hidden="true" />
          <h1>Thank you, {name.trim()}!</h1>
          <p>Your signed agreement is saved. Please hand the device back to our staff.</p>
          <button type="button" className={styles.primary} onClick={() => setExitOpen(true)}>
            Staff: back to rental
          </button>
        </section>
      )}

      {rental && !done && (rental.signedAt || rental.status !== 'active') && (
        <section className={`${styles.card} ${styles.notice}`}>
          {rental.signedAt ? `Already signed by ${rental.signerName} on ${when(rental.signedAt)}.` : 'This rental is no longer active.'}
        </section>
      )}

      {rental && !done && !rental.signedAt && rental.status === 'active' && (
        <form className={styles.flow} onSubmit={submit}>
          <div>
            <p className={styles.kicker}>Rental agreement</p>
            <h1 className={styles.title}>{rental.customer.fullName}</h1>
            {rental.customer.hotelRoom && <p className={styles.muted}>Room {rental.customer.hotelRoom}</p>}
          </div>

          <section className={styles.card} aria-labelledby="summary-title">
            <h2 id="summary-title">Your rental</h2>
            {rental.items.some((i) => i.coverMediaId) && (
              <div className={styles.vehicles}>
                {rental.items
                  .filter((i) => i.coverMediaId)
                  .map((i) => (
                    <figure key={i.id} className={styles.vehicle}>
                      <AssetImage mediaId={i.coverMediaId} kind={visualKind(i.publicLabel ?? i.label, i.assetId ? 'unit' : 'quantity')} alt={i.publicLabel ?? i.label} ratio={16 / 10} />
                      <figcaption>{i.publicLabel ?? i.label}</figcaption>
                    </figure>
                  ))}
              </div>
            )}
            <dl className={styles.facts}>
              <dt>Vehicle / items</dt>
              <dd>{rental.items.map((i) => i.publicLabel ?? i.label).join(', ')}</dd>
              <dt>Pick-up</dt>
              <dd>{when(rental.startAt)}</dd>
              <dt>Return by</dt>
              <dd>
                <b>{when(rental.dueAt)}</b>
              </dd>
              <dt>Total so far</dt>
              <dd>
                <b>{baht(rental.total)}</b>
              </dd>
              <dt>Payment</dt>
              <dd>{rental.paymentMode === 'pay_now' ? 'Pay now at the shop' : 'Pay before you check out of the hotel'}</dd>
            </dl>
          </section>

          {photos.length > 0 && (
            <section className={styles.card} aria-labelledby="photos-title">
              <h2 id="photos-title">Vehicle condition at pick-up</h2>
              <p className={styles.muted}>We took these photos together. Please check them before signing.</p>
              <ul className={styles.photos}>
                {photos.map((p) => (
                  <li key={p.id}>
                    <img src={mediaUrl(p.id)} alt={`Vehicle photo: ${SLOT_LABEL[p.slot ?? ''] ?? p.slot}`} loading="lazy" />
                    <span>{SLOT_LABEL[p.slot ?? ''] ?? p.slot}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className={styles.card} aria-labelledby="rules-title">
            <h2 id="rules-title">Rules</h2>
            <ul className={styles.rules}>
              <li>A valid driving licence is required for this type of vehicle.</li>
              <li>Driver and passenger must wear a helmet at all times.</li>
              <li>No driving under the influence of alcohol or drugs.</li>
              <li>You are responsible for damage, loss, theft and traffic fines during the rental.</li>
              <li>Return by the time above. Late returns are charged according to shop policy.</li>
              <li>Return with the same fuel level, or a fuel charge applies.</li>
            </ul>
            <fieldset className={styles.checks}>
              <legend>Please confirm</legend>
              {AGREEMENTS.map((text, i) => (
                <label key={text} className={styles.check}>
                  <input type="checkbox" checked={checks[i]} onChange={(e) => setChecks((c) => c.map((v, j) => (j === i ? e.target.checked : v)))} />
                  <span>{text}</span>
                </label>
              ))}
            </fieldset>
          </section>

          <section className={styles.card} aria-labelledby="sign-title">
            <h2 id="sign-title">Sign</h2>
            <label className={styles.field}>
              Full name (as in passport)
              <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="name" required />
            </label>
            <SignaturePad canvasRef={canvasRef} onInk={setHasInk} />
            {error && (
              <div className={styles.error} role="alert">
                {error}
              </div>
            )}
            <button className={styles.primary} disabled={!ready}>
              {busy ? 'Saving…' : 'Sign & confirm'}
            </button>
            {!ready && !busy && <p className={styles.muted}>Tick all boxes, enter your name and sign in the box to continue.</p>}
          </section>
        </form>
      )}

      {exitOpen && <StaffExit onCancel={() => setExitOpen(false)} onOk={exit} />}
    </main>
  );
}

/** ช่องเซ็นด้วยนิ้ว/ปากกา (pointer events) · ปรับความคมตามความละเอียดจอ */
function SignaturePad({ canvasRef, onInk }: { canvasRef: React.RefObject<HTMLCanvasElement | null>; onInk: (v: boolean) => void }) {
  const drawing = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const setup = useCallback(() => {
    const c = canvasRef.current;
    const w = wrapRef.current;
    if (!c || !w) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = w.clientWidth;
    const height = 200;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    c.style.width = `${width}px`;
    c.style.height = `${height}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#2a211b';
    onInk(false);
  }, [canvasRef, onInk]);

  useEffect(() => {
    setup();
    // หมุนจอ/ย่อหน้าต่าง = ล้างแล้วเซ็นใหม่ (ขนาดช่องเปลี่ยน)
    window.addEventListener('resize', setup);
    return () => window.removeEventListener('resize', setup);
  }, [setup]);

  const point = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  return (
    <div className={styles.padWrap} ref={wrapRef}>
      <p className={styles.muted} id="pad-help">
        Sign with your finger inside the box.
      </p>
      <canvas
        ref={canvasRef}
        className={styles.pad}
        role="img"
        aria-label="Signature box. Draw your signature with your finger or a stylus."
        aria-describedby="pad-help"
        onPointerDown={(e) => {
          const ctx = e.currentTarget.getContext('2d');
          if (!ctx) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          const [x, y] = point(e);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + 0.1, y + 0.1);
          ctx.stroke();
          onInk(true);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = e.currentTarget.getContext('2d');
          const [x, y] = point(e);
          ctx?.lineTo(x, y);
          ctx?.stroke();
        }}
        onPointerUp={() => (drawing.current = false)}
        onPointerCancel={() => (drawing.current = false)}
      />
      <button type="button" className={styles.clear} onClick={setup}>
        Clear
      </button>
    </div>
  );
}

/** พนักงานใส่รหัสผ่านของตัวเองเพื่อออกจากหน้าลูกค้า */
function StaffExit({ onCancel, onOk }: { onCancel: () => void; onOk: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/auth/confirm-staff', { password });
      onOk();
    } catch (err) {
      setError(err instanceof ApiError ? (ERROR_EN[err.code] ?? 'Wrong password.') : 'Wrong password.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="exit-title">
      <form className={`${styles.card} ${styles.dialog}`} onSubmit={submit}>
        <h2 id="exit-title">Staff only · พนักงานเท่านั้น</h2>
        <label className={styles.field}>
          รหัสผ่านของพนักงานที่เข้าระบบอยู่
          <input className={styles.input} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondary} onClick={onCancel}>
            Cancel
          </button>
          <button className={styles.primary} disabled={busy || !password}>
            {busy ? '…' : 'Exit'}
          </button>
        </div>
      </form>
    </div>
  );
}
