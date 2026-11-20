'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useMe } from '@/components/shell';
import { Empty, Notice, PageHeader, useLoad } from '@/components/ui';
import { api, type Customer, type RentalStatus } from '@/lib/api';
import { baht, dateText } from '@/lib/format';
import { mediaUrl, resizeImage, uploadForm, type Media } from '@/lib/api-p1';
import { messageFor } from '@/lib/messages';
import { CustomerForm, toPayload, type CustomerValues } from '../customer-form';
import styles from '../customers.module.css';
import docStyles from './docs.module.css';

const RENTAL_STATUS: Record<RentalStatus, { label: string; badge: string }> = {
  active: { label: 'เช่าอยู่', badge: 'badge-info' },
  returned: { label: 'คืนแล้ว', badge: 'badge-ok' },
  cancelled: { label: 'ยกเลิก', badge: 'badge-neutral' },
};

/** รายละเอียดลูกค้า (mock 1.10 / 1.W6) */
export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useMe();
  const canFlag = me.role === 'owner' || me.role === 'manager';
  const c = useLoad(() => api.get<Customer>(`/v1/customers/${id}`).then((r) => r.data), [id]);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);

  if (c.error && !c.data) {
    return (
      <div className={styles.page}>
        <Notice notice={{ kind: 'danger', text: c.error }} />
        <Link className="btn" href="/customers">
          กลับไปหน้าลูกค้า
        </Link>
      </div>
    );
  }
  const x = c.data;
  if (!x) return <p className="muted">กำลังโหลด…</p>;

  const initial: CustomerValues = {
    fullName: x.fullName,
    nationality: x.nationality ?? '',
    phone: x.phone ?? '',
    email: x.email ?? '',
    hotelRoom: x.hotelRoom ?? '',
    checkoutDate: x.checkoutDate ?? '',
    notes: x.notes ?? '',
  };
  const wa = (x.phone ?? '').replace(/\D/g, '');

  return (
    <div className={styles.page}>
      <PageHeader
        kicker={
          <Link href="/customers" style={{ fontSize: 13 }}>
            ← ลูกค้าทั้งหมด
          </Link>
        }
        title={x.fullName}
        actions={
          <>
            <Link className="btn btn-primary" href={`/checkout?customer=${x.id}`}>
              + ปล่อยเช่าให้ลูกค้านี้
            </Link>
            {wa.length >= 8 && (
              <a className="btn" href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">
                WhatsApp
              </a>
            )}
          </>
        }
      />

      {x.doNotRent && (
        <div className="alert alert-danger" role="alert">
          ติดธง “ไม่ให้เช่า” · {x.doNotRentReason}
        </div>
      )}
      <Notice notice={notice} />

      <div className={styles.cols}>
        <div className={styles.colMain}>
          <section className="card">
            <div className="card-head">
              <h2>ข้อมูลลูกค้า</h2>
              <button type="button" className="btn btn-sm" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
                {editing ? 'ยกเลิก' : 'แก้ไข'}
              </button>
            </div>
            <div className="card-body">
              {editing ? (
                <CustomerForm
                  initial={initial}
                  submitLabel="บันทึกการแก้ไข"
                  onSubmit={async (v) => {
                    await api.patch(`/v1/customers/${x.id}`, toPayload(v, true));
                    setEditing(false);
                    setNotice({ kind: 'ok', text: 'บันทึกแล้ว' });
                    await c.reload();
                  }}
                />
              ) : (
                <dl className={styles.facts}>
                  <dt>ห้อง</dt>
                  <dd>{x.hotelRoom ?? 'ไม่ได้พักโรงแรม'}</dd>
                  <dt>เช็คเอาท์</dt>
                  <dd>{x.checkoutDate ? dateText(x.checkoutDate) : '—'}</dd>
                  <dt>สัญชาติ</dt>
                  <dd>{x.nationality ?? '—'}</dd>
                  <dt>WhatsApp</dt>
                  <dd>{x.phone ?? '—'}</dd>
                  <dt>อีเมล</dt>
                  <dd>{x.email ?? '—'}</dd>
                  <dt>หมายเหตุ</dt>
                  <dd>{x.notes ?? '—'}</dd>
                </dl>
              )}
            </div>
          </section>

          <DocumentsCard customerId={x.id} onError={(text) => setNotice({ kind: 'danger', text })} />

          <section className="card">
            <div className="card-head">
              <h2>ประวัติการเช่า</h2>
              <span className="muted" style={{ fontSize: 13 }}>{x.rentals.length} ครั้ง</span>
            </div>
            {x.rentals.length === 0 ? (
              <Empty>ยังไม่เคยเช่า</Empty>
            ) : (
              <ul className={styles.list}>
                {x.rentals.map((r) => (
                  <li key={r.id}>
                    <Link href={`/rentals/${r.id}`} className={styles.row}>
                      <span className={styles.main}>
                        <b>
                          {dateText(r.startAt)} → {dateText(r.returnedAt ?? r.dueAt)}
                        </b>
                        <span className="muted">{r.returnedAt ? 'คืนจริง' : 'กำหนดคืน'}</span>
                      </span>
                      <span className={`badge ${RENTAL_STATUS[r.status].badge}`}>{RENTAL_STATUS[r.status].label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className={styles.colSide}>
          <section className="card">
            <div className="card-head">
              <h2>บิล</h2>
            </div>
            <div className="card-body">
              {x.openBill ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <span>
                    ยอดค้าง <b style={{ fontSize: 20 }}>{baht(x.openBill.balance)}</b>
                  </span>
                  <Link className="btn btn-primary btn-block" href={`/bills/${x.openBill.id}`}>
                    เปิดบิล / รับเงิน
                  </Link>
                </div>
              ) : (
                <p className="muted">ไม่มีบิลเปิดอยู่</p>
              )}
            </div>
          </section>

          {canFlag && <FlagCard customer={x} onDone={async (text) => { setNotice({ kind: 'ok', text }); await c.reload(); }} onError={(text) => setNotice({ kind: 'danger', text })} />}
        </aside>
      </div>
    </div>
  );
}

/** ธง "ไม่ให้เช่า" · เจ้าของ/ผู้จัดการเท่านั้น · ต้องใส่เหตุผล · เข้าประวัติเป็นรายการเสี่ยง */
function FlagCard({ customer, onDone, onError }: { customer: Customer; onDone: (text: string) => Promise<void>; onError: (text: string) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (customer.doNotRent) {
        await api.patch(`/v1/customers/${customer.id}`, { doNotRent: false });
        await onDone('เอาธง “ไม่ให้เช่า” ออกแล้ว');
      } else {
        await api.patch(`/v1/customers/${customer.id}`, { doNotRent: true, doNotRentReason: reason.trim() });
        setReason('');
        await onDone('ติดธง “ไม่ให้เช่า” แล้ว · พนักงานจะปล่อยเช่าให้ลูกค้านี้ไม่ได้');
      }
    } catch (err) {
      onError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card-head">
        <h2>ธง “ไม่ให้เช่า”</h2>
        <span className={`badge ${customer.doNotRent ? 'badge-danger' : 'badge-ok'}`}>{customer.doNotRent ? 'ติดธงอยู่' : 'ไม่มีธง'}</span>
      </div>
      <div className={`card-body ${styles.flag}`}>
        {customer.doNotRent ? (
          <p className="muted">เหตุผล: {customer.doNotRentReason}</p>
        ) : (
          <label className="field">
            เหตุผล (จำเป็น)
            <input className="input" required minLength={2} maxLength={300} placeholder="เช่น ขับประมาท ทำรถล้ม" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        )}
        <button className={`btn btn-block ${customer.doNotRent ? '' : 'btn-danger'}`} disabled={busy || (!customer.doNotRent && reason.trim().length < 2)}>
          {customer.doNotRent ? 'เอาธงออก' : 'ติดธง “ไม่ให้เช่า”'}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>บันทึกในประวัติการใช้งานทุกครั้ง</span>
      </div>
    </form>
  );
}

const DOC_SLOTS = [
  { slot: 'passport', label: 'พาสปอร์ต' },
  { slot: 'license', label: 'ใบขับขี่' },
] as const;
const DOC_LABEL: Record<string, string> = { passport: 'พาสปอร์ต', license: 'ใบขับขี่', other: 'เอกสารอื่น' };

/**
 * เอกสารลูกค้า (PDPA)
 * - รูปเบลอไว้ (ไม่โหลดรูปจริงเลย) จนกดแสดง · การโหลดรูปจริงแต่ละครั้งเข้าประวัติการใช้งาน
 * - ลบอัตโนมัติเมื่อครบกำหนด (หลังคืนรถครั้งล่าสุด + จำนวนวันที่ร้านตั้ง)
 */
function DocumentsCard({ customerId, onError }: { customerId: string; onError: (t: string) => void }) {
  const [docs, setDocs] = useState<Media[] | null>(null);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const { data } = await api.get<Media[]>(`/v1/media?customerId=${encodeURIComponent(customerId)}`);
      setDocs(data.filter((m) => m.kind === 'document'));
    } catch (e) {
      onError(messageFor(e));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);
  // คืนหน่วยความจำของรูปที่เปิดดูเมื่อออกจากหน้า
  useEffect(() => () => Object.values(shown).forEach((u) => URL.revokeObjectURL(u)), [shown]);

  async function reveal(id: string) {
    try {
      const res = await fetch(mediaUrl(id), { credentials: 'same-origin' });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      setShown((x) => ({ ...x, [id]: url }));
    } catch {
      onError('เปิดเอกสารไม่ได้ ลองใหม่อีกครั้ง');
    }
  }

  function hide(id: string) {
    setShown((x) => {
      const { [id]: url, ...rest } = x;
      if (url) URL.revokeObjectURL(url);
      return rest;
    });
  }

  async function upload(slot: string, file: File) {
    setBusy(slot);
    try {
      // เอกสารต้องอ่านตัวหนังสือได้ จึงย่อน้อยกว่ารูปรถ
      const blob = await resizeImage(file, 2000, 0.85);
      const form = new FormData();
      form.append('kind', 'document');
      form.append('slot', slot);
      form.append('customerId', customerId);
      form.append('file', blob, `${slot}.jpg`);
      await uploadForm<Media>('/v1/media', form);
      await load();
    } catch (e) {
      onError(messageFor(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" aria-labelledby="docs-title">
      <div className="card-head">
        <h2 id="docs-title">เอกสาร</h2>
        <span className="muted" style={{ fontSize: 12 }}>เบลอไว้ · เปิดดูแต่ละครั้งบันทึกในประวัติ</span>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {docs === null ? (
          <p className="muted">กำลังโหลด…</p>
        ) : docs.length === 0 ? (
          <p className="muted">ยังไม่มีรูปเอกสาร</p>
        ) : (
          <ul className={docStyles.docs}>
            {docs.map((d) => (
              <li key={d.id} className={docStyles.doc}>
                <div className={docStyles.docFrame}>
                  {shown[d.id] ? (
                    <img src={shown[d.id]} alt={`${DOC_LABEL[d.slot ?? 'other']} ของลูกค้า`} className={docStyles.docImg} />
                  ) : (
                    <span className={docStyles.docBlur} aria-hidden="true" />
                  )}
                </div>
                <div className={docStyles.docMeta}>
                  <b>{DOC_LABEL[d.slot ?? 'other']}</b>
                  <span className="muted" style={{ fontSize: 12 }}>
                    ถ่ายเมื่อ {dateText(d.createdAt)}
                    {d.deleteAfter ? ` · ลบอัตโนมัติ ${dateText(d.deleteAfter)}` : ''}
                  </span>
                  {shown[d.id] ? (
                    <button type="button" className="btn btn-sm" onClick={() => hide(d.id)}>
                      ซ่อน
                    </button>
                  ) : (
                    <button type="button" className="btn btn-sm" onClick={() => void reveal(d.id)}>
                      แสดง
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className={docStyles.docUpload}>
          {DOC_SLOTS.map(({ slot, label }) => (
            <span key={slot}>
              <label htmlFor={`doc-${slot}`} className="btn btn-block" aria-disabled={busy !== null}>
                {busy === slot ? 'กำลังส่ง…' : `+ ถ่าย${label}`}
              </label>
              <input
                id={`doc-${slot}`}
                className="sr-only"
                type="file"
                accept="image/*"
                capture="environment"
                disabled={busy !== null}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void upload(slot, f);
                }}
              />
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
