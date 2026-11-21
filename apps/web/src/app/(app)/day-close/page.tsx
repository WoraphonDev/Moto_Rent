'use client';

import { useState } from 'react';
import { CountUp, Skeleton } from '@/components/motion';
import { ConfirmButton, Empty, Notice, PageHeader, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import type { DayClose, DayCloseSummary } from '@/lib/api-p1';
import { baht, dateText, dateTimeText, METHOD_LABEL, parseBaht } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import styles from './day-close.module.css';

/** ปิดยอดสิ้นวัน (mock 1.W4 แผงขวา) · นับเงินในลิ้นชักเทียบกับที่ระบบคาด แล้วล็อกวัน */
export default function DayClosePage() {
  const [date, setDate] = useState<string | null>(null);
  const summary = useLoad(() => api.get<DayCloseSummary>(`/v1/day-close${date ? `?date=${date}` : ''}`).then((r) => r.data), [date]);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'warn'; text: string } | null>(null);

  const s = summary.data;
  const countedMinor = counted.trim() ? parseBaht(counted) : null;
  const diff = s && countedMinor !== null ? countedMinor - s.expectedCash : null;

  async function close() {
    if (!s || countedMinor === null) return setNotice({ kind: 'danger', text: 'ใส่ยอดเงินสดที่นับได้ (บาท)' });
    if (diff !== 0 && note.trim().length < 2) return setNotice({ kind: 'danger', text: 'ยอดไม่ตรง ต้องใส่หมายเหตุ เช่น ทอนผิด' });
    try {
      const { data } = await api.post<DayClose>('/v1/day-close', { date: s.date, countedCash: countedMinor, ...(note.trim() ? { note: note.trim() } : {}) });
      setNotice({
        kind: data.difference === 0 ? 'ok' : 'warn',
        text: data.difference === 0 ? `ปิดยอด ${dateText(data.date)} แล้ว · ยอดตรง` : `ปิดยอดแล้ว · ${data.difference < 0 ? 'ขาด' : 'เกิน'} ${baht(Math.abs(data.difference))} · เจ้าของเห็นในประวัติ`,
      });
      setCounted('');
      setNote('');
      await summary.reload();
    } catch (e) {
      setNotice({ kind: 'danger', text: messageFor(e) });
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader
        kicker="นับเงินในลิ้นชักทุกเย็น · ปิดแล้วแก้ยอดของวันนั้นไม่ได้"
        title="ปิดยอดสิ้นวัน"
        actions={
          <label className={styles.dateField}>
            <span className="sr-only">วันที่</span>
            <input className="input" type="date" value={s?.date ?? ''} max={s?.today} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </label>
        }
      />
      <Notice notice={summary.error ? { kind: 'danger', text: summary.error } : notice} />

      {!s ? (
        <div className="grid-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} h={300} />
          ))}
        </div>
      ) : (
        <div className="grid-3">
          <section className="card" aria-labelledby="totals-title">
            <div className="card-head">
              <h2 id="totals-title">เงินเข้า {dateText(s.date)}</h2>
              {s.closed ? <span className="badge badge-ok">ปิดยอดแล้ว</span> : <span className="badge badge-warn">ยังไม่ปิด</span>}
            </div>
            <div className="card-body" style={{ gap: 10 }}>
              {s.byMethod.length === 0 ? (
                <p className="muted">ยังไม่มีการรับเงินในวันนี้</p>
              ) : (
                <ul className={styles.methods}>
                  {s.byMethod.map((m) => (
                    <li key={m.method}>
                      <span>
                        {METHOD_LABEL[m.method]} <span className="muted">· {m.count} รายการ</span>
                      </span>
                      <b>{baht(m.total)}</b>
                    </li>
                  ))}
                </ul>
              )}
              <div className={`${styles.expected} card-foot`}>
                <span>เงินสดที่ควรมีในลิ้นชัก</span>
                <b>
                  <CountUp value={s.expectedCash} format={(n) => baht(n)} />
                </b>
              </div>
              <p className="muted" style={{ fontSize: 12 }}>PromptPay / โอน / บัตร รวม {baht(s.expectedOther)} · ตรวจกับแอปธนาคาร</p>
            </div>
          </section>

          {s.closed ? (
            <section className={`now ${styles.closedCard}`} aria-label="ปิดยอดแล้ว">
              <span className="now-label">ปิดยอดแล้ว</span>
              <h2 style={{ fontSize: 20 }}>
                นับได้ {baht(s.closed.countedCash)} · {s.closed.difference === 0 ? 'ยอดตรง' : `${s.closed.difference < 0 ? 'ขาด' : 'เกิน'} ${baht(Math.abs(s.closed.difference))}`}
              </h2>
              <span className="now-sub">
                โดย {s.closed.closedBy} · {dateTimeText(s.closed.closedAt)}
                {s.closed.note ? ` · ${s.closed.note}` : ''}
              </span>
            </section>
          ) : (
            <section className="card" aria-labelledby="count-title">
              <div className="card-head">
                <h2 id="count-title">นับเงินสด</h2>
              </div>
              <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label className="field">
                  เงินสดที่นับได้ (บาท)
                  <input className="input" inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder={String(s.expectedCash / 100)} />
                </label>
                {diff !== null && (
                  <div className={`alert ${diff === 0 ? 'alert-ok' : diff < 0 ? 'alert-danger' : 'alert-warn'}`} role="status">
                    {diff === 0 ? 'ยอดตรงกับที่ระบบคาด' : `${diff < 0 ? 'ขาด' : 'เกิน'} ${baht(Math.abs(diff))}`}
                  </div>
                )}
                {counted.trim() && countedMinor === null && <div className="alert alert-danger">จำนวนเงินไม่ถูกรูปแบบ (เช่น 2200 หรือ 2,200.50)</div>}
                <label className="field">
                  หมายเหตุ {diff !== null && diff !== 0 ? '(จำเป็นเมื่อยอดไม่ตรง)' : '(ไม่บังคับ)'}
                  <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="เช่น ทอนผิด ฿20" />
                </label>
                <div className="alert alert-warn" role="note">
                  ปิดยอดวันนี้แล้วจะรับเงินเพิ่มในวันนี้ไม่ได้ · ปิดหลังร้านปิดและรับเงินลูกค้าครบแล้ว
                </div>
                <div className="card-foot" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <ConfirmButton label="ล็อกยอดวันนี้" className="btn btn-primary btn-block" onConfirm={() => void close()} />
                  <span className="muted" style={{ fontSize: 12 }}>หลังล็อก รับเงินหรือยกเลิกบิลที่รับเงินในวันนี้ไม่ได้ · ยอดไม่ตรงบันทึกเป็นรายการเสี่ยง</span>
                </div>
              </div>
            </section>
          )}

          <section className="card" aria-labelledby="recent-title">
            <div className="card-head">
              <h2 id="recent-title">ปิดยอดล่าสุด</h2>
            </div>
            {s.recent.length === 0 ? (
              <Empty>ยังไม่เคยปิดยอด</Empty>
            ) : (
              <ul className={`${styles.recentList} motion-list`}>
                {s.recent.slice(0, 7).map((r) => (
                  <li key={r.id}>
                    <span style={{ minWidth: 0 }}>
                      <b>{dateText(r.date)}</b>
                      <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                        {r.closedBy} · นับได้ {baht(r.countedCash)} จาก {baht(r.expectedCash)}
                      </span>
                    </span>
                    {r.difference === 0 ? (
                      <span className="badge badge-ok">ตรง</span>
                    ) : (
                      <span className={`badge ${r.difference < 0 ? 'badge-danger' : 'badge-warn'}`}>
                        {r.difference < 0 ? 'ขาด' : 'เกิน'} {baht(Math.abs(r.difference))}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
