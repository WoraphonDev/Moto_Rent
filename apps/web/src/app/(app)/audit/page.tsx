'use client';

import { useCallback, useEffect, useState } from 'react';
import { useMe } from '@/components/shell';
import { Skeleton } from '@/components/motion';
import { Empty, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import type { AuditItem, AuditPage } from '@/lib/api-p2';
import { baht, dateTimeText } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import styles from './audit.module.css';

/** ชื่อเหตุการณ์เป็นภาษาไทย · ไม่รู้จัก = แสดงรหัสเดิม */
const ACTION_LABEL: Record<string, string> = {
  'auth.login': 'เข้าระบบ',
  'auth.invitation_accepted': 'ตั้งรหัสจากลิงก์เชิญ',
  'auth.password_reset': 'ตั้งรหัสผ่านใหม่',
  'org.created': 'สร้างร้าน',
  'org.updated': 'แก้ข้อมูลร้าน',
  'settings.updated': 'แก้กฎของร้าน',
  'rental.created': 'ปล่อยเช่า',
  'rental.extended': 'ต่อวัน',
  'rental.returned': 'รับคืน',
  'rental.cancelled': 'ยกเลิกสัญญา',
  'rental.signed': 'ลูกค้าเซ็นสัญญา',
  'bill.discount': 'ให้ส่วนลด',
  'bill.payment': 'รับเงิน',
  'bill.voided': 'ยกเลิกบิล',
  'bill.line_added': 'เพิ่มรายการในบิล',
  'device.requested': 'ขอเพิ่มเครื่อง',
  'device.approved': 'อนุมัติเครื่อง',
  'device.revoked': 'ตัดสิทธิ์เครื่อง',
  'device.owner_self_approved': 'เจ้าของอนุมัติเครื่องตัวเอง',
  'member.closed': 'ปิดบัญชีพนักงาน',
  'member.signed_out_everywhere': 'ออกจากทุกเครื่อง',
  'member.reset_link_created': 'ส่งลิงก์ตั้งรหัสใหม่',
  'member.discount_limit_changed': 'แก้เพดานส่วนลดรายคน',
  'invitation.created': 'สร้างลิงก์เชิญ',
  'invitation.revoked': 'ยกเลิกลิงก์เชิญ',
  'asset.created': 'เพิ่มรถ/ของ',
  'asset.updated': 'แก้ข้อมูลรถ/ของ',
  'asset.service_info_updated': 'แก้กำหนดซ่อมบำรุง',
  'asset_type.created': 'เพิ่มประเภทของให้เช่า',
  'asset_type.updated': 'แก้ประเภทของให้เช่า',
  'asset_type.price_changed': 'เปลี่ยนราคา',
  'asset_type.service_interval_changed': 'แก้รอบเปลี่ยนน้ำมันเครื่อง',
  'asset_variant.created': 'เพิ่มไซส์',
  'asset_variant.updated': 'แก้จำนวนไซส์',
  'stock.adjusted': 'ปรับสต็อก',
  'maintenance.recorded': 'บันทึกงานซ่อม',
  'customer.created': 'เพิ่มลูกค้า',
  'customer.updated': 'แก้ข้อมูลลูกค้า',
  'customer.flagged_do_not_rent': 'ติดธง “ไม่ให้เช่า”',
  'customer.unflagged': 'เอาธง “ไม่ให้เช่า” ออก',
  'document.viewed': 'เปิดดูรูปเอกสาร',
  'media.uploaded': 'อัปโหลดรูป',
  'media.purged': 'ลบรูปเอกสารตามกำหนด',
  'day_close.closed': 'ปิดยอดสิ้นวัน',
  'booking.confirmed': 'ยืนยันคำขอจอง',
  'booking.rejected': 'ปฏิเสธคำขอจอง',
};

const ACTION_GROUPS: Array<[string, string]> = [
  ['', 'ทุกเหตุการณ์'],
  ['bill', 'บิล / เงิน / ส่วนลด'],
  ['rental', 'สัญญาเช่า'],
  ['auth', 'เข้าระบบ'],
  ['device', 'เครื่อง'],
  ['member', 'พนักงาน'],
  ['settings', 'กฎของร้าน'],
  ['asset', 'รถ/ของ'],
  ['asset_type', 'ประเภท / ราคา'],
  ['stock', 'สต็อก'],
  ['maintenance', 'ซ่อมบำรุง'],
  ['customer', 'ลูกค้า'],
  ['document', 'เปิดดูเอกสาร'],
  ['booking', 'การจอง'],
];

const MONEY_KEYS = /amount|price|total|cap|limit|deposit|cost|fee|fuel|damage/i;
const FIELD_LABEL: Record<string, string> = {
  pricePerDay: 'ราคา/วัน',
  staffDiscountCap: 'เพดานส่วนลด',
  discountLimit: 'เพดานส่วนลด',
  maxRentalDays: 'วันเช่าสูงสุด',
  lateGraceMinutes: 'ผ่อนผัน (นาที)',
  lateHalfDayUntilMinutes: 'ครึ่งวันถึง (นาที)',
  depositNonGuest: 'มัดจำ',
  docRetentionDays: 'เก็บเอกสาร (วัน)',
  idleLockMinutes: 'ล็อกจอ (นาที)',
  status: 'สถานะ',
  quantity: 'จำนวน',
  dueAt: 'วันคืน',
  name: 'ชื่อ',
  timezone: 'เขตเวลา',
  odometer: 'ไมล์',
  nextServiceOdometer: 'รอบน้ำมันถัดไป',
};

function fmt(key: string, v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number' && MONEY_KEYS.test(key)) return baht(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return dateTimeText(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** สรุปค่าเดิม → ค่าใหม่ แบบสั้น (เฉพาะช่องที่มีทั้งสองฝั่งหรือมีฝั่งใหม่) */
function Diff({ item }: { item: AuditItem }) {
  const before = item.before ?? {};
  const after = item.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].slice(0, 6);
  if (!keys.length) return <span className="muted">—</span>;
  return (
    <ul className={styles.diff}>
      {keys.map((k) => (
        <li key={k}>
          <span className="muted">{FIELD_LABEL[k] ?? k}:</span>{' '}
          {k in before && k in after ? (
            <>
              <s>{fmt(k, before[k])}</s> → <b>{fmt(k, after[k])}</b>
            </>
          ) : k in after ? (
            <b>{fmt(k, after[k])}</b>
          ) : (
            <s>{fmt(k, before[k])}</s>
          )}
        </li>
      ))}
    </ul>
  );
}

// มือถือแถวกลายเป็นการ์ดสูง จึงแสดงทีละ 10 (หน้านี้ render ฝั่งเครื่องเท่านั้น หลัง Shell รู้ว่าใครเข้าระบบ)
const STEP = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 760px)').matches ? 10 : 20;

/** ประวัติการใช้งาน (mock 2.04 / 2.W5) · ลบหรือแก้ไม่ได้ (บังคับที่ฐานข้อมูล) */
export default function AuditPage() {
  const { me } = useMe();
  const allowed = me.role === 'owner' || me.role === 'manager';
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [risky, setRisky] = useState(false);
  const [items, setItems] = useState<AuditItem[]>([]);
  const [actors, setActors] = useState<AuditPage['actors']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // แสดงทีละ 20 แถว (หน้าเดิมยาว 5,000px) · หมดที่โหลดไว้แล้วค่อยขอหน้าถัดไปจากเซิร์ฟเวอร์
  const [shown, setShown] = useState(STEP);

  const query = useCallback(
    (c?: string | null) => {
      const p = new URLSearchParams();
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      if (actor) p.set('actor', actor);
      if (action) p.set('action', action);
      if (risky) p.set('risk', 'risky');
      if (c) p.set('cursor', c);
      return p.toString();
    },
    [from, to, actor, action, risky],
  );

  const load = useCallback(
    async (more = false) => {
      setLoading(true);
      setError(null);
      try {
        const { data } = await api.get<AuditPage>(`/v1/audit?${query(more ? cursor : null)}`);
        setItems((prev) => (more ? [...prev, ...data.items] : data.items));
        if (!more) setShown(STEP);
        setCursor(data.nextCursor);
        setActors(data.actors);
      } catch (e) {
        setError(messageFor(e));
      } finally {
        setLoading(false);
      }
    },
    [query, cursor],
  );

  useEffect(() => {
    if (allowed) void load(false);
    // โหลดใหม่เมื่อเปลี่ยนตัวกรอง (ไม่ใช่เมื่อ cursor เปลี่ยน)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, from, to, actor, action, risky]);

  if (!allowed) {
    return (
      <div className={styles.page}>
        <PageHeader title="ประวัติการใช้งาน" />
        <div className="alert alert-warn">หน้านี้สำหรับเจ้าของและผู้จัดการเท่านั้น</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader
        kicker="ทุกการแก้ยอด ส่วนลด ยกเลิก เข้าระบบ · ไม่มีใครลบหรือแก้ได้ รวมถึงเจ้าของ"
        title="ประวัติการใช้งาน"
        actions={
          <a className="btn" href={`/api/v1/audit.csv?${query(null)}`} download>
            ส่งออก CSV
          </a>
        }
      />

      <form className={`card ${styles.filters}`} onSubmit={(e) => e.preventDefault()} aria-label="ตัวกรอง">
        <label className="field">
          ตั้งแต่
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          ถึง
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="field">
          ใครทำ
          <select className="input" value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">ทุกคน</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          เหตุการณ์
          <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
            {ACTION_GROUPS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className={`check ${styles.riskCheck}`}>
          <input type="checkbox" checked={risky} onChange={(e) => setRisky(e.target.checked)} />
          เฉพาะรายการเสี่ยง
        </label>
      </form>

      <Notice notice={error ? { kind: 'danger', text: error } : null} />

      <section className="card">
        {items.length === 0 && loading && (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} h={40} />
            ))}
          </div>
        )}
        {items.length === 0 && !loading ? (
          <Empty>ไม่มีรายการตามตัวกรองนี้</Empty>
        ) : items.length === 0 ? null : (
          <div className="scroll-x">
            <table className="table table-stack">
              <thead>
                <tr>
                  <th scope="col">เวลา</th>
                  <th scope="col">ใคร · เครื่อง</th>
                  <th scope="col">เหตุการณ์</th>
                  <th scope="col">ค่าเดิม → ค่าใหม่</th>
                  <th scope="col">เหตุผล</th>
                </tr>
              </thead>
              <tbody>
                {items.slice(0, shown).map((i) => (
                  <tr key={i.id} className={i.risk === 'risky' ? styles.risky : undefined}>
                    <td data-label="เวลา" className={styles.nowrap}>
                      {dateTimeText(i.createdAt)}
                    </td>
                    <td data-label="ใคร">
                      <b>{i.actorName ?? 'ระบบ'}</b>
                      {i.deviceName && <div className="muted" style={{ fontSize: 12 }}>{i.deviceName}</div>}
                    </td>
                    <td data-label="เหตุการณ์">
                      <span className={styles.actionCell}>
                        {i.risk === 'risky' && <span className="badge badge-warn">รายการเสี่ยง</span>}
                        <span>{ACTION_LABEL[i.action] ?? i.action}</span>
                      </span>
                    </td>
                    <td data-label="รายละเอียด">
                      <Diff item={i} />
                    </td>
                    <td data-label="เหตุผล">{i.reason ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(shown < items.length || cursor) && (
          <div className="card-body" style={{ display: 'flex', justifyContent: 'center' }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={loading}
              onClick={() => {
                if (shown >= items.length && cursor) void load(true);
                setShown((n) => n + STEP);
              }}
            >
              {loading ? 'กำลังดึงรายการ…' : `แสดงอีก ${STEP} รายการ`}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
