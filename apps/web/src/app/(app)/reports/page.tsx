'use client';

import { useMemo, useState } from 'react';
import { useMe } from '@/components/shell';
import { CountUp, Segmented, Skeleton, useShowMore } from '@/components/motion';
import { Empty, Notice, PageHeader, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import type { ReportSummary } from '@/lib/api-p2';
import { baht, dateText, LINE_LABEL, METHOD_LABEL } from '@/lib/format';
import styles from './reports.module.css';

type Preset = 'today' | '7d' | 'month' | 'custom';

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function rangeFor(p: Exclude<Preset, 'custom'>): [string, string] {
  const now = new Date();
  if (p === 'today') return [ymd(now), ymd(now)];
  if (p === '7d') {
    const s = new Date(now);
    s.setDate(s.getDate() - 6);
    return [ymd(s), ymd(now)];
  }
  return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ymd(now)];
}

const CHANNEL_LABEL: Record<string, string> = { walk_in: 'หน้าร้าน', hotel: 'โรงแรม', booking_page: 'จองออนไลน์', marketplace: 'Marketplace' };

/** รายงานเจ้าของ (mock 2.W1) · ตัวเลขจริงจากระบบ */
export default function ReportsPage() {
  const { me } = useMe();
  const allowed = me.role === 'owner' || me.role === 'manager';
  const [preset, setPreset] = useState<Preset>('month');
  const [[from, to], setRange] = useState<[string, string]>(() => rangeFor('month'));
  const report = useLoad(() => (allowed ? api.get<ReportSummary>(`/v1/reports/summary?from=${from}&to=${to}`).then((r) => r.data) : Promise.resolve(null)), [from, to, allowed]);
  const assetRows = useShowMore(report.data?.assets ?? [], 8);

  if (!allowed) {
    return (
      <div className={styles.page}>
        <PageHeader title="รายงาน" />
        <div className="alert alert-warn">หน้านี้สำหรับเจ้าของและผู้จัดการเท่านั้น</div>
      </div>
    );
  }

  const r = report.data;
  return (
    <div className={styles.page}>
      <PageHeader
        kicker={r ? `${dateText(r.range.from)} – ${dateText(r.range.to)} · เวลา ${r.range.timezone}` : 'รายได้ · เงินเข้า · รถคันไหนคุ้ม'}
        title="รายงาน"
        actions={
          <a className="btn" href={`/api/v1/reports/summary.csv?from=${from}&to=${to}`} download>
            ส่งออก Excel (CSV)
          </a>
        }
      />

      <div className={styles.rangeBar}>
        <Segmented<Preset>
          label="ช่วงเวลา"
          value={preset}
          onChange={(k) => {
            setPreset(k);
            if (k !== 'custom') setRange(rangeFor(k));
          }}
          options={[
            { value: 'today', label: 'วันนี้' },
            { value: '7d', label: '7 วัน' },
            { value: 'month', label: 'เดือนนี้' },
            { value: 'custom', label: 'กำหนดเอง' },
          ]}
        />
        {preset === 'custom' && (
          <div className={styles.custom}>
            <label className="field">
              ตั้งแต่
              <input className="input" type="date" value={from} max={to} onChange={(e) => e.target.value && setRange([e.target.value, to])} />
            </label>
            <label className="field">
              ถึง
              <input className="input" type="date" value={to} min={from} onChange={(e) => e.target.value && setRange([from, e.target.value])} />
            </label>
          </div>
        )}
      </div>

      <Notice notice={report.error ? { kind: 'danger', text: report.error } : null} />
      {!r && !report.error && (
        <>
          <div className="kpis">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} h={96} />
            ))}
          </div>
          <Skeleton h={280} />
        </>
      )}

      {r && (
        <>
          <section className="kpis" aria-label="ตัวเลขสรุป">
            <Kpi label="รายได้" value={r.totals.revenue} format={baht} sub={`${r.totals.rentals} สัญญาเริ่มในช่วงนี้`} tone="ok" />
            <Kpi label="เงินเข้าจริง" value={r.totals.payments} format={baht} sub={r.paymentsByMethod.map((p) => `${METHOD_LABEL[p.method]} ${baht(p.amount)}`).join(' · ') || 'ยังไม่มี'} tone="info" />
            <Kpi label="บิลค้างจ่ายตอนนี้" value={r.totals.openBills} format={baht} sub={`${r.totals.openBillCount} บิล`} tone="warn" />
            <Kpi label="อัตราใช้รถเฉลี่ย" value={r.totals.avgUtilizationPct} format={(n) => `${n}%`} sub={`ค่าซ่อม ${baht(r.totals.maintenanceCost)}`} tone="neutral" />
          </section>

          <section className="card">
            <div className="card-head">
              <h2>รายได้รายวัน</h2>
              <span className="muted" style={{ fontSize: 13 }}>
                แท่ง = รายได้ · จุด = เงินเข้า
              </span>
            </div>
            <div className="card-body">
              <DailyChart daily={r.daily} />
            </div>
          </section>

          <div className="grid-3">
            <section className="card">
              <div className="card-head">
                <h2>รายได้ตามประเภทรายการ</h2>
              </div>
              {r.revenueByKind.length === 0 ? (
                <Empty>ยังไม่มีรายได้ในช่วงนี้</Empty>
              ) : (
                <ul className={styles.rows}>
                  {r.revenueByKind.map((k) => (
                    <li key={k.kind}>
                      <span>{LINE_LABEL[k.kind as keyof typeof LINE_LABEL] ?? k.kind}</span>
                      <b className={k.amount < 0 ? styles.neg : undefined}>{baht(k.amount)}</b>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card">
              <div className="card-head">
                <h2>รายได้ตามประเภทของให้เช่า</h2>
              </div>
              {r.revenueByType.length === 0 ? (
                <Empty>ยังไม่มีรายได้ในช่วงนี้</Empty>
              ) : (
                <ul className={styles.rows}>
                  {r.revenueByType.map((t) => (
                    <li key={t.typeId}>
                      <span>{t.name}</span>
                      <b>{baht(t.revenue)}</b>
                    </li>
                  ))}
                  {r.totals.unattributedRevenue !== 0 && (
                    <li>
                      <span className="muted">ไม่ระบุรถ (ส่วนลด/ค่าระดับบิล)</span>
                      <b className={r.totals.unattributedRevenue < 0 ? styles.neg : undefined}>{baht(r.totals.unattributedRevenue)}</b>
                    </li>
                  )}
                </ul>
              )}
            </section>
            <section className="card">
              <div className="card-head">
                <h2>ลูกค้ามาจากไหน</h2>
              </div>
              <ul className={styles.rows}>
                <li>
                  <span>แขกโรงแรม</span>
                  <b>{r.channels.hotelGuests} สัญญา</b>
                </li>
                <li>
                  <span>นอกโรงแรม</span>
                  <b>{r.channels.nonHotel} สัญญา</b>
                </li>
                {r.channels.byChannel.map((c) => (
                  <li key={c.channel}>
                    <span className="muted">ช่องทาง: {CHANNEL_LABEL[c.channel] ?? c.channel}</span>
                    <b>{c.count}</b>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <section className="card">
            <div className="card-head">
              <h2>รถแต่ละคัน · คุ้มไหม</h2>
              <span className="muted" style={{ fontSize: 13 }}>
                กำไร = รายได้ที่แบ่งลงคัน − ค่าซ่อม · อัตราใช้ = ชั่วโมงที่ถูกเช่า ÷ ชั่วโมงในช่วง ({r.range.hours} ชม.)
              </span>
            </div>
            {r.assets.length === 0 ? (
              <Empty>ยังไม่มีรถ</Empty>
            ) : (
              <div className="scroll-x">
                <table className="table table-stack">
                  <thead>
                    <tr>
                      <th scope="col">รถ</th>
                      <th scope="col">รายได้</th>
                      <th scope="col">ค่าซ่อม</th>
                      <th scope="col">กำไร</th>
                      <th scope="col">อัตราใช้</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assetRows.visible.map((x) => (
                      <tr key={x.assetId}>
                        <td>
                          <b>{x.code}</b> <span className="muted">{x.typeName}</span>
                        </td>
                        <td data-label="รายได้">{baht(x.revenue)}</td>
                        <td data-label="ค่าซ่อม">{baht(x.maintenanceCost)}</td>
                        <td data-label="กำไร">
                          <b className={x.profit < 0 ? styles.neg : undefined}>{baht(x.profit)}</b>
                          {x.profit < 0 && <span className="badge badge-danger" style={{ marginLeft: 6 }}>ขาดทุน</span>}
                        </td>
                        <td data-label="อัตราใช้">
                          <span className={styles.util}>
                            <span className={styles.utilBar} aria-hidden="true">
                              <span className="motion-bar" style={{ width: `${Math.min(100, x.utilizationPct)}%` }} />
                            </span>
                            {x.utilizationPct}% {x.utilizationPct < 20 && <span className="badge badge-warn">วิ่งน้อย</span>}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {assetRows.more}
          </section>
          <p className="muted" style={{ fontSize: 12 }}>
            รายได้นับตามเวลาที่บันทึกรายการในบิล (ไม่นับบิลที่ยกเลิก) · เงินเข้านับตามเวลารับเงิน · สัญญาหลายชิ้นแบ่งรายได้ลงแต่ละชิ้นตามสัดส่วนราคาต่อวัน
          </p>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, format, sub, tone }: { label: string; value: number; format: (n: number) => string; sub: string; tone: 'ok' | 'info' | 'warn' | 'neutral' }) {
  return (
    <div className={styles.kpi} data-tone={tone}>
      <span className={styles.kpiLabel}>{label}</span>
      <span className={styles.kpiValue}>
        <CountUp value={value} format={format} />
      </span>
      <span className={styles.kpiSub}>{sub}</span>
    </div>
  );
}

/** กราฟแท่งรายวัน (SVG ล้วน) · มีคำอธิบายสำหรับโปรแกรมอ่านจอ + ตารางซ่อนสำรอง */
function DailyChart({ daily }: { daily: ReportSummary['daily'] }) {
  const W = 720;
  const H = 220;
  const pad = { l: 8, r: 8, t: 12, b: 26 };
  const max = useMemo(() => Math.max(1, ...daily.map((d) => Math.max(d.revenue, d.payments))), [daily]);
  if (!daily.length) return <Empty>ไม่มีข้อมูล</Empty>;
  const bw = (W - pad.l - pad.r) / daily.length;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - Math.max(0, v) / max);
  const total = daily.reduce((s, d) => s + d.revenue, 0);
  const best = daily.reduce((b, d) => (d.revenue > b.revenue ? d : b), daily[0]!);
  const labelEvery = Math.ceil(daily.length / 10);
  const summary = `รายได้รวม ${baht(total)} ใน ${daily.length} วัน · วันที่มากที่สุด ${dateText(best.date)} ${baht(best.revenue)}`;
  return (
    <figure className={styles.chart}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} preserveAspectRatio="none">
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--line-strong)" />
        {daily.map((d, i) => {
          const x = pad.l + i * bw;
          const top = y(d.revenue);
          return (
            <g key={d.date}>
              <rect
                className="motion-bar-v"
                style={{ transformBox: 'fill-box', animationDelay: `${Math.min(i, 20) * 30}ms` }}
                x={x + bw * 0.15}
                y={top}
                width={bw * 0.7}
                height={Math.max(0, y(0) - top)}
                rx={Math.min(4, bw * 0.2)}
                fill="var(--primary)"
              >
                <title>{`${dateText(d.date)} · รายได้ ${baht(d.revenue)} · เงินเข้า ${baht(d.payments)}`}</title>
              </rect>
              {d.payments > 0 && <circle cx={x + bw / 2} cy={y(d.payments)} r={Math.min(4, bw * 0.25)} fill="var(--accent)" />}
              {i % labelEvery === 0 && (
                <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--muted)">
                  {Number(d.date.slice(8))}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="muted" style={{ fontSize: 12 }}>
        {summary}
      </figcaption>
    </figure>
  );
}
