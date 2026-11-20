'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useMe } from '@/components/shell';
import { Notice, PageHeader, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import type { OrgSettings, SettingsResponse } from '@/lib/api-p2';
import { baht, parseBaht } from '@/lib/format';
import { messageFor, ROLE_LABEL } from '@/lib/messages';
import styles from './shop.module.css';

type NoticeT = { kind: 'ok' | 'danger'; text: string } | null;

const TIMEZONES = ['Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Jakarta', 'Asia/Makassar', 'Asia/Kuala_Lumpur', 'Asia/Singapore', 'Asia/Manila', 'Asia/Yangon', 'Asia/Phnom_Penh', 'Asia/Tokyo', 'Europe/London', 'UTC'];

/**
 * ค่าคืนช้า (ตัวอย่างสด) · สูตรเดียวกับ packages/core lateFee:
 * เลยไม่เกินช่วงผ่อนผัน = 0 · ไม่เกินช่วงครึ่งวัน = ครึ่งวัน · เกินกว่านั้น = เต็มวันตามจำนวนวันที่เลย (ปัดขึ้น)
 */
function lateFeeExample(perDay: number, lateMinutes: number, grace: number, halfDayUntil: number): number {
  if (lateMinutes <= grace) return 0;
  if (lateMinutes <= halfDayUntil) return Math.round(perDay / 2);
  return perDay * Math.ceil(lateMinutes / 1440);
}

const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} ชม.`;

/** ตั้งค่า · กฎและข้อมูลร้าน (mock 2.03 / 2.W4) · เจ้าของเท่านั้น */
export default function ShopSettingsPage() {
  const { me, reload: reloadMe } = useMe();
  const isOwner = me.role === 'owner';
  const data = useLoad(() => api.get<SettingsResponse>('/v1/settings').then((r) => r.data));
  const [notice, setNotice] = useState<NoticeT>(null);

  async function run(action: () => Promise<unknown>, ok: string) {
    setNotice(null);
    try {
      await action();
      setNotice({ kind: 'ok', text: ok });
      await data.reload();
      await reloadMe();
    } catch (e) {
      setNotice({ kind: 'danger', text: messageFor(e) });
    }
  }

  if (!isOwner) {
    return (
      <div className={styles.page}>
        <PageHeader title="กฎและข้อมูลร้าน" />
        <div className="alert alert-warn">หน้านี้สำหรับเจ้าของร้านเท่านั้น</div>
      </div>
    );
  }

  const d = data.data;
  return (
    <div className={styles.page}>
      <PageHeader kicker="ตั้งค่า · เจ้าของเท่านั้น · ทุกการเปลี่ยนแปลงเข้าประวัติการใช้งาน" title="กฎและข้อมูลร้าน" />
      <Notice notice={notice ?? (data.error ? { kind: 'danger', text: data.error } : null)} />
      {d && (
        <div className={styles.grid}>
          <OrgCard org={d.org} run={run} />
          <BookingCard enabled={d.settings.publicBookingEnabled} slug={d.org.slug} run={run} />
          <RulesForm key={`rules-${d.settings.lateGraceMinutes}-${d.settings.lateHalfDayUntilMinutes}-${d.settings.maxRentalDays}`} s={d.settings} run={run} />
          <MoneyForm key={`money-${d.settings.staffDiscountCap}-${d.settings.depositNonGuest}`} s={d.settings} run={run} />
          <SecurityForm key={`sec-${d.settings.docRetentionDays}-${d.settings.idleLockMinutes}`} s={d.settings} run={run} />
          <StaffLimits staff={d.staff} cap={d.settings.staffDiscountCap} run={run} />
        </div>
      )}
    </div>
  );
}

type Run = (f: () => Promise<unknown>, ok: string) => Promise<void>;

function Section({ title, hint, children, onSubmit, submitLabel = 'บันทึก' }: { title: string; hint?: string; children: ReactNode; onSubmit: (e: FormEvent) => void; submitLabel?: string }) {
  return (
    <form className={`card ${styles.section}`} onSubmit={onSubmit}>
      <div>
        <h2>{title}</h2>
        {hint && <p className="muted" style={{ fontSize: 13 }}>{hint}</p>}
      </div>
      {children}
      <button className="btn btn-primary">{submitLabel}</button>
    </form>
  );
}

function OrgCard({ org, run }: { org: SettingsResponse['org']; run: Run }) {
  const [name, setName] = useState(org.name);
  const [tz, setTz] = useState(org.timezone);
  return (
    <Section
      title="ข้อมูลร้าน"
      hint={`ที่อยู่หน้าจอง: ${org.slug} · สกุลเงิน ${org.currency}`}
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => api.patch('/v1/orgs/current', { name: name.trim(), timezone: tz }), 'บันทึกข้อมูลร้านแล้ว');
      }}
    >
      <label className="field">
        ชื่อร้าน
        <input className="input" required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        เขตเวลา <span className="muted" style={{ fontWeight: 400 }}>(ใช้นับ “วันนี้” ในรายงานและการปิดยอด)</span>
        <select className="input" value={tz} onChange={(e) => setTz(e.target.value)}>
          {[...new Set([tz, ...TIMEZONES])].map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </label>
    </Section>
  );
}

/** เปิด/ปิดหน้าจองออนไลน์ · ร้านใหม่ปิดไว้ก่อน (กันคำขอจองปลอมก่อนร้านพร้อม) · บันทึกทันทีเมื่อกดสวิตช์ */
function BookingCard({ enabled, slug, run }: { enabled: boolean; slug: string; run: Run }) {
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const url = `${origin}/book/${slug}`;
  async function toggle(next: boolean) {
    setBusy(true);
    await run(() => api.patch('/v1/settings', { publicBookingEnabled: next }), next ? 'เปิดหน้าจองออนไลน์แล้ว' : 'ปิดหน้าจองออนไลน์แล้ว');
    setBusy(false);
  }
  return (
    <section className={`card ${styles.section}`}>
      <div>
        <h2>หน้าจองออนไลน์</h2>
        <p className="muted" style={{ fontSize: 13 }}>ลูกค้าส่งคำขอจองเองผ่านลิงก์หรือ QR · ร้านยืนยันก่อนทุกครั้ง</p>
      </div>
      <label className={styles.switchRow}>
        <input type="checkbox" role="switch" className={styles.switch} checked={enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        <span>
          <b>เปิดหน้าจองออนไลน์</b>
          <span className="muted" style={{ display: 'block', fontSize: 13 }}>{enabled ? 'เปิดอยู่ · ลูกค้าเห็นหน้าจองได้' : 'ปิดอยู่ · ลิงก์และ QR จะขึ้นว่าร้านไม่รับจองออนไลน์'}</span>
        </span>
      </label>
      {enabled && origin && (
        <div className={styles.example}>
          ลิงก์หน้าจอง:{' '}
          <a href={url} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>
            {url}
          </a>
        </div>
      )}
    </section>
  );
}

function intOrNull(v: string): number | null | 'bad' {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 'bad';
}

function RulesForm({ s, run }: { s: OrgSettings; run: Run }) {
  const [grace, setGrace] = useState(String(s.lateGraceMinutes));
  const [half, setHalf] = useState(String(s.lateHalfDayUntilMinutes));
  const [maxDays, setMaxDays] = useState(s.maxRentalDays?.toString() ?? '');
  const [error, setError] = useState<string | null>(null);
  const g = Number(grace) || 0;
  const h = Number(half) || 0;
  const perDay = 25_000; // ตัวอย่างด้วยราคา ฿250/วัน
  const examples = [30, 100, 240, 300, 1500];

  return (
    <Section
      title="กฎเวลาและค่าคืนช้า"
      hint="ระบบเสนอค่าคืนช้าตามกฎนี้ตอนรับคืน · พนักงานแก้ได้แต่ต้องใส่เหตุผล"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const md = intOrNull(maxDays);
        if (md === 'bad' || (md !== null && md < 1)) return setError('จำนวนวันเช่าสูงสุดไม่ถูกต้อง');
        if (!Number.isInteger(g) || !Number.isInteger(h) || g < 0 || h < 0) return setError('นาทีต้องเป็นจำนวนเต็ม');
        if (h < g) return setError('ช่วง “คิดครึ่งวัน” ต้องยาวกว่าช่วงผ่อนผัน');
        void run(() => api.patch('/v1/settings', { lateGraceMinutes: g, lateHalfDayUntilMinutes: h, maxRentalDays: md }), 'บันทึกกฎเวลาแล้ว');
      }}
    >
      <div className={styles.twoCol}>
        <label className="field">
          ผ่อนผัน (นาที)
          <input className="input" inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value.replace(/\D/g, ''))} />
        </label>
        <label className="field">
          คิดครึ่งวันถึง (นาที)
          <input className="input" inputMode="numeric" value={half} onChange={(e) => setHalf(e.target.value.replace(/\D/g, ''))} />
        </label>
      </div>
      <label className="field">
        เช่าได้นานสุด (วัน) <span className="muted" style={{ fontWeight: 400 }}>(ว่าง = ไม่จำกัด)</span>
        <input className="input" inputMode="numeric" value={maxDays} onChange={(e) => setMaxDays(e.target.value.replace(/\D/g, ''))} />
      </label>
      <div className={styles.example} aria-live="polite">
        <b>ตัวอย่าง (รถ ฿250/วัน)</b>
        <ul>
          {examples.map((m) => (
            <li key={m}>
              เลย {hm(m)} → <b>{baht(lateFeeExample(perDay, m, g, h))}</b>
            </li>
          ))}
        </ul>
      </div>
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
    </Section>
  );
}

function MoneyForm({ s, run }: { s: OrgSettings; run: Run }) {
  const [deposit, setDeposit] = useState(s.depositNonGuest === null ? '' : String(s.depositNonGuest / 100));
  const [cap, setCap] = useState(String(s.staffDiscountCap / 100));
  const [error, setError] = useState<string | null>(null);
  return (
    <Section
      title="มัดจำและส่วนลด"
      hint="ส่วนลดเกินเพดาน พนักงานทำเองไม่ได้ ต้องให้เจ้าของทำ"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const dep = deposit.trim() === '' ? null : parseBaht(deposit);
        const c = parseBaht(cap);
        if (deposit.trim() !== '' && dep === null) return setError('มัดจำไม่ถูกต้อง');
        if (c === null) return setError('เพดานส่วนลดไม่ถูกต้อง');
        void run(() => api.patch('/v1/settings', { depositNonGuest: dep, staffDiscountCap: c }), 'บันทึกมัดจำและส่วนลดแล้ว');
      }}
    >
      <label className="field">
        มัดจำลูกค้านอกโรงแรม (บาท) <span className="muted" style={{ fontWeight: 400 }}>(ว่าง = ยังไม่ตั้ง)</span>
        <input className="input" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
      </label>
      <label className="field">
        เพดานส่วนลดของพนักงาน (บาท ต่อครั้ง)
        <input className="input" inputMode="decimal" required value={cap} onChange={(e) => setCap(e.target.value)} />
      </label>
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
    </Section>
  );
}

function SecurityForm({ s, run }: { s: OrgSettings; run: Run }) {
  const [retention, setRetention] = useState(String(s.docRetentionDays));
  const [idle, setIdle] = useState(String(s.idleLockMinutes));
  return (
    <Section
      title="เอกสารและความปลอดภัย"
      hint="รูปพาสปอร์ต/ใบขับขี่ลบเองเมื่อครบกำหนด (PDPA) · ลบแล้วกู้คืนไม่ได้"
      onSubmit={(e) => {
        e.preventDefault();
        const r = Number(retention);
        const i = Number(idle);
        if (!Number.isInteger(r) || r < 1 || !Number.isInteger(i) || i < 1) return;
        void run(() => api.patch('/v1/settings', { docRetentionDays: r, idleLockMinutes: i }), 'บันทึกการตั้งค่าความปลอดภัยแล้ว');
      }}
    >
      <label className="field">
        ลบรูปเอกสารหลังคืนรถ (วัน)
        <input className="input" inputMode="numeric" value={retention} onChange={(e) => setRetention(e.target.value.replace(/\D/g, ''))} />
      </label>
      <label className="field">
        ล็อกหน้าจอเมื่อไม่ได้แตะ (นาที)
        <input className="input" inputMode="numeric" value={idle} onChange={(e) => setIdle(e.target.value.replace(/\D/g, ''))} />
      </label>
    </Section>
  );
}

function StaffLimits({ staff, cap, run }: { staff: SettingsResponse['staff']; cap: number; run: Run }) {
  return (
    <section className={`card ${styles.wide}`}>
      <div className="card-head">
        <h2>เพดานส่วนลดรายคน</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          ว่าง = ใช้ค่าของร้าน ({baht(cap)}) · เจ้าของไม่มีเพดาน
        </span>
      </div>
      <div className="scroll-x">
        <table className="table table-stack">
          <thead>
            <tr>
              <th scope="col">พนักงาน</th>
              <th scope="col">สิทธิ์</th>
              <th scope="col">เพดานส่วนลด</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((m) => (
              <tr key={m.userId}>
                <td>
                  <b>{m.displayName}</b> <span className="muted">{m.username}</span>
                </td>
                <td data-label="สิทธิ์">
                  <span className={m.role === 'owner' ? 'badge badge-owner' : 'badge badge-neutral'}>{ROLE_LABEL[m.role]}</span>
                </td>
                <td data-label="เพดานส่วนลด">{m.role === 'owner' ? <span className="muted">ไม่มีเพดาน</span> : <LimitEditor m={m} cap={cap} run={run} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LimitEditor({ m, cap, run }: { m: SettingsResponse['staff'][number]; cap: number; run: Run }) {
  const [v, setV] = useState(m.discountLimit === null ? '' : String(m.discountLimit / 100));
  useEffect(() => setV(m.discountLimit === null ? '' : String(m.discountLimit / 100)), [m.discountLimit]);
  return (
    <form
      className={styles.limitRow}
      onSubmit={(e) => {
        e.preventDefault();
        const limit = v.trim() === '' ? null : parseBaht(v);
        if (v.trim() !== '' && limit === null) return;
        void run(() => api.patch(`/v1/members/${m.userId}/discount-limit`, { limit }), `บันทึกเพดานส่วนลดของ ${m.displayName} แล้ว`);
      }}
    >
      <label className="sr-only" htmlFor={`lim-${m.userId}`}>
        เพดานส่วนลดของ {m.displayName} (บาท)
      </label>
      <input id={`lim-${m.userId}`} className="input" inputMode="decimal" placeholder={`ค่าร้าน ${baht(cap)}`} value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn btn-sm">บันทึก</button>
    </form>
  );
}
