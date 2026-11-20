'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { latestBySlot, PhotoSlots, PHOTO_SLOTS, useRentalPhotos } from '@/components/photo-slots';
import { useMe } from '@/components/shell';
import { ConfirmButton, Notice, PageHeader, Stepper, useLoad } from '@/components/ui';
import { api, type Rental, type ReturnPreview } from '@/lib/api';
import { baht, dateTimeText, LINE_LABEL, overdueText, parseBaht, dateText } from '@/lib/format';
import type { Media, RentalWithSign } from '@/lib/api-p1';
import { messageFor } from '@/lib/messages';
import styles from './rental.module.css';

type NoticeT = { kind: 'ok' | 'danger' | 'warn'; text: string } | null;

const STATUS: Record<Rental['status'], { label: string; cls: string }> = {
  active: { label: 'เช่าอยู่', cls: 'badge-info' },
  returned: { label: 'คืนแล้ว', cls: 'badge-ok' },
  cancelled: { label: 'ยกเลิก', cls: 'badge-neutral' },
};

/** สัญญา + ต่อวัน + รับคืน (mock 1.06 / 1.09 / 1.W3) */
export default function RentalPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useMe();
  const rental = useLoad(() => api.get<RentalWithSign>(`/v1/rentals/${encodeURIComponent(id)}`).then((r) => r.data), [id]);
  const photos = useRentalPhotos(id);
  const [notice, setNotice] = useState<NoticeT>(null);
  const r = rental.data;

  // มาจากปุ่ม "รับคืน" (#return): เลื่อนลงหาฟอร์มเมื่อโหลดเสร็จ
  useEffect(() => {
    if (r && window.location.hash === '#return') document.getElementById('return')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [r]);

  if (rental.error) return <Notice notice={{ kind: 'danger', text: rental.error }} />;
  if (!r) return <p className="muted">กำลังโหลด…</p>;

  const billId = r.billId;
  const active = r.status === 'active';
  const hasUnit = r.items.some((i) => i.assetId);
  const checkoutCount = latestBySlot(photos.photos, 'checkout').size;
  const returnCount = latestBySlot(photos.photos, 'return').size;
  const setRental = (next: Rental) => rental.setData({ ...(next as RentalWithSign) });

  return (
    <div className={styles.page}>
      <PageHeader
        kicker={
          <Link href="/rentals" style={{ fontSize: 13 }}>
            ← สัญญาทั้งหมด
          </Link>
        }
        title={r.customer.fullName}
        actions={
          billId && (
            <Link className="btn" href={`/bills/${billId}`} style={{ minHeight: 44 }}>
              ดูบิล
            </Link>
          )
        }
      />
      <Notice notice={notice} />

      {active && r.overdue && (
        <section className="now" aria-label="ตอนนี้">
          <span className="now-label">ตอนนี้ · {overdueText(r.dueAt)}</span>
          <h2 style={{ fontSize: 20 }}>ครบคืน {dateTimeText(r.dueAt)}</h2>
          <span className="now-sub">
            {r.customer.hotelRoom ? `ห้อง ${r.customer.hotelRoom}` : 'นอกโรงแรม'}
            {r.customer.phone ? ` · ${r.customer.phone}` : ''}
          </span>
          {r.customer.phone && (
            <a className={styles.nowBtn} href={`https://wa.me/${r.customer.phone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">
              ทัก WhatsApp
            </a>
          )}
        </section>
      )}

      {active && hasUnit && (checkoutCount < PHOTO_SLOTS.length || !r.signedAt) && (
        <section className="alert alert-warn" aria-label="ขั้นต่อไป" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ flex: 1 }}>
            <b>ขั้นต่อไป:</b> {checkoutCount < PHOTO_SLOTS.length ? `ถ่ายรูปรถตอนปล่อย (ได้ ${checkoutCount}/${PHOTO_SLOTS.length})` : 'รูปรถครบแล้ว'}
            {' · '}
            {r.signedAt ? 'ลูกค้าเซ็นแล้ว' : 'ให้ลูกค้าเซ็นสัญญา'}
          </span>
          <span className={styles.nextActions}>
            {checkoutCount < PHOTO_SLOTS.length && (
              <a className="btn btn-sm" href="#photos">
                ถ่ายรูป
              </a>
            )}
            {!r.signedAt && (
              <Link className="btn btn-sm btn-primary" href={`/sign/${r.id}`}>
                ให้ลูกค้าเซ็น
              </Link>
            )}
          </span>
        </section>
      )}

      <div className={styles.cols}>
        <div className={styles.colMain}>
          <section className="card">
            <div className="card-head">
              <h2>สัญญา</h2>
              <span className={`badge ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
            </div>
            <dl className={`card-body ${styles.facts}`}>
              <dt>ลูกค้า</dt>
              <dd>
                {r.customer.fullName}
                {r.customer.hotelRoom ? ` · ห้อง ${r.customer.hotelRoom}` : ''}
              </dd>
              <dt>เริ่ม</dt>
              <dd>{dateTimeText(r.startAt)}</dd>
              <dt>ครบคืน</dt>
              <dd>
                {dateTimeText(r.dueAt)} {active && r.overdue && <span className="badge badge-danger">{overdueText(r.dueAt)}</span>}
              </dd>
              {r.returnedAt && (
                <>
                  <dt>คืนจริง</dt>
                  <dd>{dateTimeText(r.returnedAt)}</dd>
                </>
              )}
              {r.customer.checkoutDate && (
                <>
                  <dt>เช็คเอาท์โรงแรม</dt>
                  <dd>{dateText(r.customer.checkoutDate)}</dd>
                </>
              )}
              <dt>ของ</dt>
              <dd>
                <span className={styles.itemList}>
                  {r.items.map((i) => (
                    <span key={i.id} className="badge badge-neutral">
                      {i.label}
                    </span>
                  ))}
                </span>
              </dd>
            </dl>
          </section>

          {hasUnit && (
            <section className="card" id="photos" aria-labelledby="photos-title">
              <div className="card-head">
                <h2 id="photos-title">รูปรถตอนปล่อย</h2>
                <span className={`badge ${checkoutCount >= PHOTO_SLOTS.length ? 'badge-ok' : 'badge-warn'}`}>
                  {checkoutCount}/{PHOTO_SLOTS.length} รูป
                </span>
              </div>
              <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {photos.error && <div className="alert alert-danger">{photos.error}</div>}
                {active && checkoutCount < PHOTO_SLOTS.length && (
                  <div className="alert alert-warn">ถ่ายให้ครบ 6 รูปก่อนลูกค้าออกจากร้าน · เป็นหลักฐานสภาพรถ ลดการเถียงตอนคืน</div>
                )}
                <PhotoSlots rentalId={r.id} stage="checkout" photos={photos.photos} onUploaded={() => void photos.reload()} readOnly={!active} />
                <SignStatus rental={r} />
              </div>
            </section>
          )}

          {!active && returnCount > 0 && (
            <section className="card">
              <div className="card-head">
                <h2>รูปรถตอนรับคืน</h2>
                <span className="badge badge-neutral">{returnCount}/{PHOTO_SLOTS.length} รูป · มุมขวาล่าง = ตอนปล่อย</span>
              </div>
              <div className="card-body">
                <PhotoSlots rentalId={r.id} stage="return" photos={photos.photos} onUploaded={() => void photos.reload()} readOnly />
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-head">
              <h2>รายการในบิล</h2>
              {billId && (
                <Link href={`/bills/${billId}`} style={{ fontSize: 13, fontWeight: 600 }}>
                  ไปที่บิล →
                </Link>
              )}
            </div>
            <ul className={styles.lines}>
              {r.lines.map((l) => (
                <li key={l.id}>
                  <span style={{ minWidth: 0 }}>
                    <span className="badge badge-neutral">{LINE_LABEL[l.kind]}</span> {l.description}
                    {l.reason && <span className="muted" style={{ display: 'block', fontSize: 12 }}>เหตุผล: {l.reason}</span>}
                  </span>
                  <b className={l.amount < 0 ? styles.neg : undefined}>{baht(l.amount)}</b>
                </li>
              ))}
            </ul>
            <div className={styles.total}>
              <span>รวมสัญญานี้</span>
              <b>{baht(r.total)}</b>
            </div>
          </section>

        </div>

        {active && (
          <div className={styles.colSide}>
            <ExtendCard
              rental={r}
              maxDays={me.settings.maxRentalDays}
              onDone={(next, days) => {
                setRental(next);
                setNotice({ kind: 'ok', text: `ต่ออีก ${days} วันแล้ว · คืน ${dateTimeText(next.dueAt)}` });
              }}
              onError={(t) => setNotice({ kind: 'danger', text: t })}
            />
            <ReturnCard
              rental={r}
              photos={photos.photos}
              onPhotos={() => void photos.reload()}
              onDone={(next) => {
                setRental(next);
                setNotice({ kind: 'ok', text: 'รับคืนแล้ว · ของกลับเข้าร้าน ยอดเข้าบิลแล้ว' });
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              onError={(t) => setNotice({ kind: 'danger', text: t })}
            />
          </div>
        )}

        {!active && r.status === 'returned' && billId && (
          <div className={styles.colSide}>
            <section className="now">
              <span className="now-label">รับคืนแล้ว</span>
              <h2 style={{ fontSize: 20 }}>ยอดสัญญานี้ {baht(r.total)}</h2>
              <span className="now-sub">ยอดรวมอยู่ในบิลของลูกค้า เก็บตอนเช็คเอาท์หรือรับเงินเลยก็ได้</span>
              <Link className={styles.nowBtn} href={`/bills/${billId}`}>
                รับเงิน
              </Link>
            </section>
          </div>
        )}
      </div>
      {active && me.role === 'owner' && <CancelCard id={r.id} onDone={(next) => { setRental(next); setNotice({ kind: 'ok', text: 'ยกเลิกสัญญาแล้ว' }); }} onError={(t) => setNotice({ kind: 'danger', text: t })} />}
    </div>
  );
}

function ExtendCard({ rental, maxDays, onDone, onError }: { rental: Rental; maxDays: number | null; onDone: (r: Rental, days: number) => void; onError: (t: string) => void }) {
  const [days, setDays] = useState(1);
  const [busy, setBusy] = useState(false);
  const used = Math.round((new Date(rental.dueAt).getTime() - new Date(rental.startAt).getTime()) / 86_400_000);
  const max = Math.max(0, (maxDays ?? 60) - used);
  const newDue = new Date(new Date(rental.dueAt).getTime() + days * 86_400_000).toISOString();
  const perDay = rental.items.reduce((s, i) => s + i.pricePerDay * i.quantity, 0);

  async function submit() {
    setBusy(true);
    try {
      const { data } = await api.post<Rental>(`/v1/rentals/${rental.id}/extend`, { days });
      onDone(data, days);
      setDays(1);
    } catch (e) {
      onError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="extend-title">
      <div className="card-head">
        <h2 id="extend-title">ต่อวัน</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          เช่าไปแล้ว {used} วัน{maxDays ? ` · สูงสุด ${maxDays}` : ''}
        </span>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {max < 1 ? (
          <p className="muted">ครบจำนวนวันเช่าสูงสุดของร้านแล้ว</p>
        ) : (
          <>
            <Stepper label="จำนวนวันที่ต่อ" value={days} min={1} max={max} unit="วัน" onChange={setDays} />
            <div className={styles.kv}>
              <span className="muted">คืนใหม่</span>
              <b>{dateTimeText(newDue)}</b>
              <span className="muted">เพิ่มในบิล</span>
              <b>{baht(perDay * days)}</b>
            </div>
            <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={submit}>
              {busy ? 'กำลังบันทึก…' : `ยืนยันต่อ ${days} วัน`}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function ReturnCard({
  rental,
  photos,
  onPhotos,
  onDone,
  onError,
}: {
  rental: Rental;
  photos: Media[];
  onPhotos: () => void;
  onDone: (r: Rental) => void;
  onError: (t: string) => void;
}) {
  const returnCount = latestBySlot(photos, 'return').size;
  const preview = useLoad(() => api.get<ReturnPreview>(`/v1/rentals/${rental.id}/return-preview`).then((r) => r.data), [rental.id]);
  const hasUnit = rental.items.some((i) => i.assetId);
  const [odometer, setOdometer] = useState('');
  const [fuel, setFuel] = useState('');
  const [damage, setDamage] = useState('');
  const [damageNote, setDamageNote] = useState('');
  const [override, setOverride] = useState(false);
  const [lateAmount, setLateAmount] = useState('');
  const [lateReason, setLateReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const p = preview.data;
  const fuelMinor = fuel.trim() ? parseBaht(fuel) : 0;
  const damageMinor = damage.trim() ? parseBaht(damage) : 0;
  const lateMinor = override ? parseBaht(lateAmount) : (p?.suggestedLateFee ?? 0);
  const extra = (lateMinor ?? 0) + (fuelMinor ?? 0) + (damageMinor ?? 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (fuelMinor === null || damageMinor === null || (override && lateMinor === null)) return setError('จำนวนเงินไม่ถูกรูปแบบ (ใส่เป็นบาท เช่น 125)');
    if ((damageMinor ?? 0) > 0 && damageNote.trim().length < 2) return setError('ใส่รายละเอียดความเสียหาย');
    if (override && lateReason.trim().length < 2) return setError('แก้ค่าคืนช้าต้องใส่เหตุผล');
    // เวลาที่กดรับคืนจริง · ถ้าเน็ตหลุดแล้วส่งทีหลัง ลูกค้าไม่โดนค่าคืนช้าเพิ่ม
    const body: Record<string, unknown> = { returnedAt: new Date().toISOString() };
    if (odometer.trim()) {
      const n = Number(odometer.replace(/[,\s]/g, ''));
      if (!Number.isInteger(n) || n < 0) return setError('เลขไมล์ไม่ถูกต้อง');
      body.odometer = n;
    }
    if (fuelMinor) body.fuel = fuelMinor;
    if (damageMinor) body.damage = { amount: damageMinor, note: damageNote.trim() };
    if (override) body.lateFeeOverride = { amount: lateMinor, reason: lateReason.trim() };
    setBusy(true);
    try {
      const { data } = await api.post<Rental>(`/v1/rentals/${rental.id}/return`, body);
      onDone(data);
    } catch (err) {
      onError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form id="return" className={`card ${styles.returnCard}`} onSubmit={submit} aria-labelledby="return-title">
      <div className="card-head">
        <h2 id="return-title">รับคืน</h2>
        {p && (p.lateMinutes > 0 ? <span className="badge badge-danger">เลย {Math.floor(p.lateMinutes / 60)}:{String(p.lateMinutes % 60).padStart(2, '0')} ชม.</span> : <span className="badge badge-ok">ตรงเวลา</span>)}
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {preview.error && <div className="alert alert-danger">{preview.error}</div>}
        {hasUnit && (
          <div className={styles.returnPhotos}>
            <span className={styles.subhead}>
              รูปรถตอนรับคืน <span className="muted">· มุมขวาล่างของแต่ละช่อง = รูปตอนปล่อย ใช้เทียบรอยใหม่</span>
            </span>
            <PhotoSlots rentalId={rental.id} stage="return" photos={photos} onUploaded={onPhotos} />
            {returnCount < PHOTO_SLOTS.length && (
              <div className="alert alert-warn">ยังถ่ายรูปตอนรับคืนไม่ครบ ({returnCount}/{PHOTO_SLOTS.length}) · ถ้ามีรอยใหม่ ต้องมีรูปเป็นหลักฐาน</div>
            )}
          </div>
        )}
        <div className={styles.kv}>
          <span className="muted">ค่าคืนช้าที่ระบบคิด</span>
          <b>{p ? baht(p.suggestedLateFee) : '…'}</b>
        </div>
        <label className="check">
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
          แก้ค่าคืนช้า <span className="muted">(ต้องใส่เหตุผล · เจ้าของเห็นในประวัติ)</span>
        </label>
        {override && (
          <div className={styles.grid2}>
            <label className="field">
              ค่าคืนช้า (บาท)
              <input className="input" inputMode="decimal" value={lateAmount} onChange={(e) => setLateAmount(e.target.value)} placeholder="0" />
            </label>
            <label className="field">
              เหตุผล
              <input className="input" value={lateReason} onChange={(e) => setLateReason(e.target.value)} maxLength={300} placeholder="เช่น เรือเลื่อน" />
            </label>
          </div>
        )}
        <div className={styles.grid2}>
          {hasUnit && (
            <label className="field">
              เลขไมล์ <span className="muted" style={{ fontWeight: 400 }}>(ไม่บังคับ)</span>
              <input className="input" inputMode="numeric" value={odometer} onChange={(e) => setOdometer(e.target.value)} />
            </label>
          )}
          <label className="field">
            ค่าน้ำมัน (บาท) <span className="muted" style={{ fontWeight: 400 }}>(ไม่บังคับ)</span>
            <input className="input" inputMode="decimal" value={fuel} onChange={(e) => setFuel(e.target.value)} placeholder="0" />
          </label>
          <label className="field">
            ค่าเสียหาย (บาท) <span className="muted" style={{ fontWeight: 400 }}>(ไม่บังคับ)</span>
            <input className="input" inputMode="decimal" value={damage} onChange={(e) => setDamage(e.target.value)} placeholder="0" />
          </label>
          {(damageMinor ?? 0) > 0 && (
            <label className="field">
              รายละเอียดความเสียหาย
              <input className="input" value={damageNote} onChange={(e) => setDamageNote(e.target.value)} maxLength={300} placeholder="เช่น รอยขีดข่วนบังโคลนซ้าย" />
            </label>
          )}
        </div>
        <div className={styles.kv}>
          <span className="muted">ยอดเพิ่มตอนรับคืน</span>
          <b>{baht(extra)}</b>
        </div>
        {error && (
          <div className="alert alert-danger" role="alert">
            {error}
          </div>
        )}
        <button className="btn btn-primary btn-block" disabled={busy || !p}>
          {busy ? 'กำลังบันทึก…' : 'ยืนยันรับคืน'}
        </button>
      </div>
    </form>
  );
}

function CancelCard({ id, onDone, onError }: { id: string; onDone: (r: Rental) => void; onError: (t: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <section className="card">
      <div className="card-head">
        <h2>ยกเลิกสัญญา</h2>
        <span className="badge badge-owner">เจ้าของเท่านั้น</span>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p className="muted" style={{ fontSize: 13 }}>ของกลับเข้าร้าน และยอดของสัญญานี้ในบิลที่ยังเปิดถูกหักคืน · บันทึกเป็นรายการเสี่ยง</p>
        <label className="field">
          เหตุผล
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </label>
        <ConfirmButton
          label="ยกเลิกสัญญา"
          danger
          className="btn btn-danger btn-block"
          onConfirm={async () => {
            if (reason.trim().length < 2) return onError('ใส่เหตุผลก่อนยกเลิก');
            try {
              const { data } = await api.post<Rental>(`/v1/rentals/${id}/cancel`, { reason: reason.trim() });
              onDone(data);
            } catch (e) {
              onError(messageFor(e));
            }
          }}
        />
      </div>
    </section>
  );
}

/** ลายเซ็นลูกค้า (mock 1.05) · หน้าเซ็นเป็นภาษาอังกฤษและล็อกไว้จนพนักงานใส่รหัสผ่าน */
function SignStatus({ rental }: { rental: RentalWithSign }) {
  if (rental.signedAt) {
    return (
      <div className="alert alert-ok">
        ลูกค้าเซ็นแล้ว · {rental.signerName} · {dateTimeText(rental.signedAt)}
      </div>
    );
  }
  if (rental.status !== 'active') return <p className="muted">ไม่มีลายเซ็นลูกค้าในสัญญานี้</p>;
  return (
    <div className={styles.signRow}>
      <span className="muted" style={{ flex: 1 }}>
        ลูกค้ายังไม่ได้เซ็นสัญญา · ยื่นเครื่องให้ลูกค้าอ่านเงื่อนไขและเซ็น (ภาษาอังกฤษ)
      </span>
      <Link className="btn btn-primary" href={`/sign/${rental.id}`}>
        ให้ลูกค้าเซ็น
      </Link>
    </div>
  );
}
