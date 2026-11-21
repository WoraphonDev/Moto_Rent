'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useMe } from '@/components/shell';
import { CountUp, PageSkeleton } from '@/components/motion';
import { ConfirmButton, Notice, PageHeader, useLoad } from '@/components/ui';
import { api, ApiError, type Bill, type PaymentMethod } from '@/lib/api';
import { baht, dateTimeText, LINE_LABEL, METHOD_LABEL, parseBaht, dateText } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import styles from './bill.module.css';

type NoticeT = { kind: 'ok' | 'danger' | 'warn'; text: string } | null;
type AddKind = 'discount' | 'fuel' | 'damage' | 'gear' | 'other';

const ADD_KINDS: Array<[AddKind, string]> = [
  ['discount', 'ส่วนลด'],
  ['fuel', 'น้ำมัน'],
  ['damage', 'ค่าเสียหาย'],
  ['gear', 'อุปกรณ์'],
  ['other', 'อื่นๆ'],
];
const METHODS: PaymentMethod[] = ['cash', 'promptpay', 'transfer', 'card'];

/** บิล + รับเงิน (mock 1.07 / 1.W4) */
export default function BillPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useMe();
  const bill = useLoad(() => api.get<Bill>(`/v1/bills/${encodeURIComponent(id)}`).then((r) => r.data), [id]);
  const [notice, setNotice] = useState<NoticeT>(null);
  const b = bill.data;

  if (bill.error) return <Notice notice={{ kind: 'danger', text: bill.error }} />;
  if (!b) return <PageSkeleton />;

  const open = b.status === 'open';
  const statusBadge = b.status === 'open' ? <span className="badge badge-warn">ค้างจ่าย</span> : b.status === 'paid' ? <span className="badge badge-ok">จ่ายแล้ว</span> : <span className="badge badge-neutral">ยกเลิกแล้ว</span>;

  return (
    <div className={styles.page}>
      <PageHeader
        kicker={
          <Link href="/bills" style={{ fontSize: 13 }}>
            ← บิลทั้งหมด
          </Link>
        }
        title={
          <>
            {b.customer.hotelRoom ? `ห้อง ${b.customer.hotelRoom} · ` : ''}
            {b.customer.fullName}
          </>
        }
        actions={statusBadge}
      />
      <Notice notice={notice} />

      {b.status === 'paid' && <PaidCard bill={b} />}
      {b.status === 'void' && (
        <div className="alert alert-warn" role="status">
          บิลนี้ถูกยกเลิก{b.voidReason ? ` · เหตุผล: ${b.voidReason}` : ''}
        </div>
      )}

      <div className="split">
        <div className="split-main">
          <section className="card">
            <div className="card-head">
              <h2>รายการ</h2>
              {b.customer.checkoutDate && <span className="muted" style={{ fontSize: 13 }}>เช็คเอาท์ {dateText(b.customer.checkoutDate)}</span>}
            </div>
            <ul className={styles.lines}>
              {b.lines.map((l) => (
                <li key={l.id}>
                  <span style={{ minWidth: 0 }}>
                    <span className={l.kind === 'discount' ? 'badge badge-ok' : 'badge badge-neutral'}>{LINE_LABEL[l.kind]}</span> {l.description}
                    <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                      {l.by} · {dateTimeText(l.createdAt)}
                      {l.reason ? ` · เหตุผล: ${l.reason}` : ''}
                      {l.rentalId && (
                        <>
                          {' · '}
                          <Link href={`/rentals/${l.rentalId}`}>สัญญา</Link>
                        </>
                      )}
                    </span>
                  </span>
                  <b className={l.amount < 0 ? styles.neg : undefined}>{baht(l.amount)}</b>
                </li>
              ))}
            </ul>
            <dl className={styles.totals}>
              <dt>รวม</dt>
              <dd>{baht(b.total)}</dd>
              <dt>จ่ายแล้ว</dt>
              <dd>{baht(b.paid)}</dd>
              <dt className={styles.balanceLabel}>คงค้าง</dt>
              <dd className={styles.balance}>{baht(b.balance)}</dd>
            </dl>
          </section>

          {b.payments.length > 0 && (
            <section className="card">
              <div className="card-head">
                <h2>การรับเงิน</h2>
              </div>
              <ul className={styles.lines}>
                {b.payments.map((p) => (
                  <li key={p.id}>
                    <span>
                      <span className="badge badge-info">{METHOD_LABEL[p.method]}</span>
                      <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                        {p.by} · {dateTimeText(p.createdAt)}
                      </span>
                    </span>
                    <b>{baht(p.amount)}</b>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {open && (
            <AddLineCard
              billId={b.id}
              onDone={(text) => {
                setNotice({ kind: 'ok', text });
                void bill.reload();
              }}
              onError={(t) => setNotice({ kind: 'danger', text: t })}
            />
          )}
        </div>

        <aside className="split-side">
          <section className="card" aria-label="ยอดบิล">
            <div className={`card-body ${styles.sum}`}>
              <span className="muted">{b.status === 'paid' ? 'ยอดรวม' : 'คงค้าง'}</span>
              <b className={styles.sumBig}>
                <CountUp value={b.status === 'paid' ? b.total : b.balance} format={(n) => baht(n)} />
              </b>
              <span className="muted" style={{ fontSize: 13 }}>
                รวม {baht(b.total)} · จ่ายแล้ว {baht(b.paid)} · {b.lines.length} รายการ
              </span>
            </div>
          </section>
          {open && b.balance > 0 && (
            <PayCard
              bill={b}
              onDone={(next) => {
                bill.setData(next);
                setNotice({ kind: 'ok', text: next.status === 'paid' ? `ปิดบิลแล้ว · ใบเสร็จ ${next.receiptNo}` : `รับเงินแล้ว · คงค้าง ${baht(next.balance)}` });
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              onError={(t) => setNotice({ kind: 'danger', text: t })}
            />
          )}
          {open && (b.refundDue ?? 0) > 0 && (
            <div className="alert alert-warn" role="status">
              ลูกค้าจ่ายเกิน · ต้องคืนเงิน {baht(b.refundDue ?? 0)} (เช่น ยกเลิกสัญญาหลังจ่ายแล้ว) · บิลยังเปิดไว้จนกว่าจะคืนเงิน
            </div>
          )}
          {open && b.balance === 0 && (
            <div className="alert alert-ok" role="status">
              ไม่มียอดค้าง
            </div>
          )}
          {me.role === 'owner' && b.status !== 'void' && (
            <VoidCard
              billId={b.id}
              onDone={(next) => {
                bill.setData(next);
                setNotice({ kind: 'warn', text: 'ยกเลิกบิลแล้ว · บันทึกเป็นรายการเสี่ยง' });
              }}
              onError={(t) => setNotice({ kind: 'danger', text: t })}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function PaidCard({ bill }: { bill: Bill }) {
  const { me } = useMe();
  const digits = (bill.customer.phone ?? '').replace(/\D/g, '');
  const text = [
    `${me.org.name} · Receipt ${bill.receiptNo ?? ''}`,
    bill.customer.fullName + (bill.customer.hotelRoom ? ` · Room ${bill.customer.hotelRoom}` : ''),
    ...bill.lines.map((l) => `${l.description}: ${baht(l.amount)}`),
    `Total: ${baht(bill.total)}`,
    `Paid: ${bill.payments.map((p) => `${METHOD_LABEL[p.method]} ${baht(p.amount)}`).join(', ')}`,
    'Thank you!',
  ].join('\n');
  const wa = `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
  return (
    <section className="now" aria-label="ใบเสร็จ">
      <span className="now-label">จ่ายครบแล้ว</span>
      <span className={styles.receipt}>{bill.receiptNo}</span>
      <span className="now-sub">
        รวม {baht(bill.total)}
        {bill.paidAt ? ` · ${dateTimeText(bill.paidAt)}` : ''}
      </span>
      <a className={styles.nowBtn} href={wa} target="_blank" rel="noreferrer">
        ส่งใบเสร็จทาง WhatsApp
      </a>
    </section>
  );
}

function AddLineCard({ billId, onDone, onError }: { billId: string; onDone: (text: string) => void; onError: (t: string) => void }) {
  const [kind, setKind] = useState<AddKind>('discount');
  const [description, setDescription] = useState('ส่วนลด');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const needsReason = kind === 'discount' || kind === 'other';

  async function submit(e: FormEvent) {
    e.preventDefault();
    const minor = parseBaht(amount);
    if (!minor) return onError('ใส่จำนวนเงินเป็นบาท เช่น 100');
    if (!description.trim()) return onError('ใส่รายละเอียด');
    if (needsReason && reason.trim().length < 2) return onError('ส่วนลดและรายการอื่นๆ ต้องใส่เหตุผล');
    setBusy(true);
    try {
      await api.post(`/v1/bills/${billId}/lines`, { kind, description: description.trim(), amount: minor, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      onDone(`เพิ่ม${kind === 'discount' ? 'ส่วนลด' : 'รายการ'} ${baht(kind === 'discount' ? -minor : minor)} แล้ว`);
      setAmount('');
      setReason('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'discount_over_limit') onError('ส่วนลดเกินเพดานของคุณ · ต้องให้เจ้าของร้านทำ');
      else onError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit} aria-labelledby="add-title">
      <div className="card-head">
        <h2 id="add-title">เพิ่มรายการ</h2>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className={styles.kinds} role="radiogroup" aria-label="ประเภทรายการ">
          {ADD_KINDS.map(([k, label]) => (
            <label key={k} className={styles.kind} data-on={kind === k}>
              <input
                type="radio"
                name="kind"
                value={k}
                checked={kind === k}
                onChange={() => {
                  setKind(k);
                  setDescription(label);
                }}
              />
              {label}
            </label>
          ))}
        </div>
        <div className={styles.grid2}>
          <label className="field">
            รายละเอียด
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={120} />
          </label>
          <label className="field">
            จำนวนเงิน (บาท)
            <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </label>
        </div>
        {needsReason && (
          <label className="field">
            เหตุผล <span className="muted" style={{ fontWeight: 400 }}>(เจ้าของเห็นในประวัติ)</span>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="เช่น ลูกค้าประจำ" />
          </label>
        )}
        <button className="btn btn-block" disabled={busy}>
          {busy ? 'กำลังบันทึก…' : kind === 'discount' ? 'เพิ่มส่วนลด' : 'เพิ่มรายการ'}
        </button>
      </div>
    </form>
  );
}

interface PayRow {
  method: PaymentMethod;
  amount: string;
}

function PayCard({ bill, onDone, onError }: { bill: Bill; onDone: (b: Bill) => void; onError: (t: string) => void }) {
  const [rows, setRows] = useState<PayRow[]>([{ method: 'cash', amount: String(bill.balance / 100) }]);
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);

  // ยอดค้างเปลี่ยน (เพิ่มรายการ/รับเงินบางส่วน) → เริ่มใหม่จากยอดใหม่
  useEffect(() => {
    setRows([{ method: 'cash', amount: String(bill.balance / 100) }]);
    setReceived('');
  }, [bill.balance]);

  const parsed = rows.map((r) => parseBaht(r.amount));
  const valid = parsed.every((v) => v !== null && v > 0);
  const paying = parsed.reduce<number>((s, v) => s + (v ?? 0), 0);
  const remaining = bill.balance - paying;
  const cash = rows.reduce((s, r, i) => s + (r.method === 'cash' ? (parsed[i] ?? 0) : 0), 0);
  const receivedMinor = received.trim() ? parseBaht(received) : null;
  const change = receivedMinor !== null ? receivedMinor - cash : null;

  function update(i: number, patch: Partial<PayRow>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return onError('จำนวนเงินไม่ถูกรูปแบบ');
    if (remaining < 0) return onError('รับเงินเกินยอดค้าง');
    setBusy(true);
    try {
      const { data } = await api.post<Bill>(`/v1/bills/${bill.id}/payments`, { payments: rows.map((r, i) => ({ method: r.method, amount: parsed[i]! })) });
      onDone(data);
    } catch (err) {
      onError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`card ${styles.payCard}`} onSubmit={submit} aria-labelledby="pay-title">
      <div className="card-head">
        <h2 id="pay-title">รับเงิน</h2>
        <b className={styles.payBalance}>{baht(bill.balance)}</b>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {rows.map((r, i) => (
          <div key={i} className={styles.payRow}>
            <div className={styles.methods} role="radiogroup" aria-label={`วิธีจ่ายรายการที่ ${i + 1}`}>
              {METHODS.map((m) => (
                <button key={m} type="button" className={styles.method} aria-pressed={r.method === m} onClick={() => update(i, { method: m })}>
                  {METHOD_LABEL[m]}
                </button>
              ))}
            </div>
            <div className={styles.amountRow}>
              <label className="field" style={{ flex: 1 }}>
                <span className="sr-only">จำนวนเงิน (บาท)</span>
                <input className="input" inputMode="decimal" value={r.amount} onChange={(e) => update(i, { amount: e.target.value })} aria-invalid={parsed[i] === null ? true : undefined} />
              </label>
              {rows.length > 1 && (
                <button type="button" className="btn" style={{ minHeight: 44 }} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label="ลบรายการจ่ายนี้">
                  ลบ
                </button>
              )}
            </div>
          </div>
        ))}
        {rows.length < 4 && (
          <button
            type="button"
            className="btn btn-sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setRows((rs) => [...rs, { method: 'promptpay', amount: remaining > 0 ? String(remaining / 100) : '' }])}
          >
            + แยกจ่ายอีกวิธี
          </button>
        )}
        <div className={styles.kv}>
          <span className="muted">รับครั้งนี้</span>
          <b>{baht(paying)}</b>
          <span className="muted">{remaining >= 0 ? 'คงค้างหลังรับ' : 'เกินยอด'}</span>
          <b className={remaining < 0 ? styles.over : undefined}>{baht(Math.abs(remaining))}</b>
        </div>
        {cash > 0 && (
          <div className={styles.changeBox}>
            <label className="field">
              รับเงินสดมา (บาท) <span className="muted" style={{ fontWeight: 400 }}>(ไว้คิดเงินทอน)</span>
              <input className="input" inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} placeholder={String(cash / 100)} />
            </label>
            {change !== null && (
              <div className={styles.kv}>
                <span className="muted">{change >= 0 ? 'เงินทอน' : 'ยังขาด'}</span>
                <b className={change < 0 ? styles.over : undefined}>{baht(Math.abs(change))}</b>
              </div>
            )}
          </div>
        )}
        <button className="btn btn-primary btn-block" disabled={busy || !valid || remaining < 0 || paying <= 0}>
          {busy ? 'กำลังบันทึก…' : remaining === 0 ? `รับ ${baht(paying)} · ปิดบิล` : `รับ ${baht(paying)}`}
        </button>
      </div>
    </form>
  );
}

function VoidCard({ billId, onDone, onError }: { billId: string; onDone: (b: Bill) => void; onError: (t: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <section className="card">
      <div className="card-head">
        <h2>ยกเลิกบิล</h2>
        <span className="badge badge-owner">เจ้าของเท่านั้น</span>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label className="field">
          เหตุผล
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </label>
        <ConfirmButton
          label="ยกเลิกบิล"
          danger
          className="btn btn-danger btn-block"
          onConfirm={async () => {
            if (reason.trim().length < 2) return onError('ใส่เหตุผลก่อนยกเลิกบิล');
            try {
              const { data } = await api.post<Bill>(`/v1/bills/${billId}/void`, { reason: reason.trim() });
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
