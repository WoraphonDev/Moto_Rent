'use client';

import { useState, type FormEvent } from 'react';
import { messageFor } from '@/lib/messages';
import styles from './customers.module.css';

export interface CustomerValues {
  fullName: string;
  nationality: string;
  phone: string;
  email: string;
  hotelRoom: string;
  checkoutDate: string;
  notes: string;
}

export const emptyCustomer: CustomerValues = { fullName: '', nationality: '', phone: '', email: '', hotelRoom: '', checkoutDate: '', notes: '' };

/** เพิ่มใหม่: ส่งเฉพาะช่องที่มีค่า · แก้ไข (forEdit): ส่งทุกช่อง ช่องว่าง = ล้างค่าเดิม */
export function toPayload(v: CustomerValues, forEdit = false): Record<string, string> {
  const out: Record<string, string> = { fullName: v.fullName.trim() };
  for (const k of ['nationality', 'phone', 'email', 'hotelRoom', 'checkoutDate', 'notes'] as const) {
    const val = v[k].trim();
    if (val || forEdit) out[k] = val;
  }
  return out;
}

/** ฟอร์มลูกค้าใช้ทั้งเพิ่มใหม่และแก้ไข (ใช้เฉพาะในหน้าลูกค้า) */
export function CustomerForm({ initial, submitLabel, onSubmit }: { initial: CustomerValues; submitLabel: string; onSubmit: (v: CustomerValues) => Promise<void> }) {
  const [v, setV] = useState<CustomerValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof CustomerValues) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(v);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.formGrid}>
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          ชื่อตามพาสปอร์ต
          <input className="input" required maxLength={100} autoComplete="off" value={v.fullName} onChange={set('fullName')} />
        </label>
        <label className="field">
          เลขห้อง
          <input className="input" maxLength={10} value={v.hotelRoom} onChange={set('hotelRoom')} />
        </label>
        <label className="field">
          วันเช็คเอาท์โรงแรม
          <input className="input" type="date" value={v.checkoutDate} onChange={set('checkoutDate')} />
        </label>
        <label className="field">
          สัญชาติ
          <input className="input" maxLength={40} value={v.nationality} onChange={set('nationality')} />
        </label>
        <label className="field">
          WhatsApp / เบอร์
          <input className="input" inputMode="tel" placeholder="+4512345678" maxLength={20} value={v.phone} onChange={set('phone')} />
        </label>
        <label className="field">
          อีเมล
          <input className="input" type="email" maxLength={120} value={v.email} onChange={set('email')} />
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          หมายเหตุ
          <input className="input" maxLength={1000} placeholder="เช่น ขับดี มาทุกปี" value={v.notes} onChange={set('notes')} />
        </label>
      </div>
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
      <button className="btn btn-primary btn-block" disabled={busy || !v.fullName.trim()}>
        {busy ? 'กำลังบันทึก…' : submitLabel}
      </button>
    </form>
  );
}
