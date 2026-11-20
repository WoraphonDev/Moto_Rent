'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useMe } from '@/components/shell';
import { Empty, Notice, useLoad } from '@/components/ui';
import { api, type Asset, type AssetState, type RentalSummary, type Today } from '@/lib/api';
import { baht, dueText, METHOD_LABEL, overdueText, STATE_LABEL, timeText } from '@/lib/format';
import styles from './home.module.css';

type Focus = 'overdue' | 'unpaid' | 'due' | 'active';

function greeting(hour: number) {
  if (hour < 12) return 'สวัสดีตอนเช้า';
  if (hour < 17) return 'สวัสดีตอนบ่าย';
  return 'สวัสดีตอนเย็น';
}

const waLink = (phone: string | null) => {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? `https://wa.me/${digits}` : null;
};

const TILE_BG: Record<AssetState, string> = {
  available: 'var(--ok-soft)',
  rented: 'var(--info-soft)',
  overdue: 'var(--danger-soft)',
  maintenance: 'var(--sunk)',
};
const TILE_INK: Record<AssetState, string> = {
  available: 'var(--ok-text)',
  rented: 'var(--info-text)',
  overdue: 'var(--danger-text)',
  maintenance: 'var(--ink-soft)',
};

/** หน้าหลักวันนี้ (mock 1.02 / 1.W1 / H.02 / H.W2) */
export default function HomePage() {
  const { me } = useMe();
  const [focus, setFocus] = useState<Focus>('overdue');
  const today = useLoad(() => api.get<Today>('/v1/today').then((r) => r.data));
  const fleet = useLoad(() => api.get<Asset[]>('/v1/assets').then((r) => r.data));
  const active = useLoad(() => api.get<RentalSummary[]>('/v1/rentals?status=active').then((r) => r.data));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      void today.reload();
      void fleet.reload();
      void active.reload();
    }, 30_000);
    return () => clearInterval(t);
  }, [today.reload, fleet.reload, active.reload]);

  const t = today.data;
  const assets = fleet.data ?? [];
  const dateLabel = new Date().toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const moneyTotal = (t?.moneyToday ?? []).reduce((s, m) => s + m.total, 0);

  const tiles: Array<{ key: Focus; label: string; n: string; sub: string; bg: string; ink: string }> = [
    { key: 'overdue', label: 'เลยกำหนดคืน', n: String(t?.overdue.length ?? '–'), sub: 'ทักลูกค้าก่อน', bg: 'var(--danger-soft)', ink: 'var(--danger-text)' },
    {
      key: 'unpaid',
      label: 'เช็คเอาท์ค้างจ่าย',
      n: t ? baht(t.unpaidCheckouts.reduce((s, u) => s + u.balance, 0)) : '–',
      sub: `${t?.unpaidCheckouts.length ?? 0} ราย · เก็บก่อนขึ้นเรือ`,
      bg: 'var(--warn-soft)',
      ink: 'var(--warn-text)',
    },
    { key: 'due', label: 'คืนวันนี้', n: String(t?.dueToday.length ?? '–'), sub: 'ยังไม่ถึงเวลา', bg: 'var(--info-soft)', ink: 'var(--info-text)' },
    { key: 'active', label: 'เช่าอยู่ทั้งหมด', n: String(t?.activeCount ?? '–'), sub: 'สัญญาที่ยังไม่คืน', bg: 'var(--ok-soft)', ink: 'var(--ok-text)' },
  ];

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div style={{ minWidth: 0 }}>
          <p className="muted">{dateLabel}</p>
          <h1 className={styles.title}>
            {greeting(new Date().getHours())} {me.user.displayName}
          </h1>
        </div>
        <div className={styles.bigActions}>
          <Link className="btn btn-primary" href="/checkout">
            + ปล่อยเช่า
          </Link>
          <Link className="btn" href="/rentals">
            รับคืน
          </Link>
        </div>
      </div>

      <Notice notice={today.error ? { kind: 'danger', text: today.error } : null} />

      <NowCard today={t} now={now} />

      <section className={styles.tiles} aria-label="ตัวเลขวันนี้">
        {tiles.map((x) => (
          <button
            key={x.key}
            type="button"
            className={styles.tile}
            style={{ background: x.bg }}
            aria-pressed={focus === x.key}
            onClick={() => setFocus(x.key)}
          >
            <span className={styles.tileLabel} style={{ color: x.ink }}>
              {x.label}
            </span>
            <span className={styles.tileNum}>{x.n}</span>
            <span className={styles.tileSub} style={{ color: x.ink }}>
              {x.sub}
            </span>
          </button>
        ))}
      </section>

      <div className={styles.cols}>
        <section className={`card ${styles.listCard}`} aria-live="polite">
          <div className="card-head">
            <h2>{tiles.find((x) => x.key === focus)!.label}</h2>
          </div>
          <FocusList focus={focus} today={t} active={active.data} now={now} />
        </section>

        <aside className={styles.side}>
          <section className="card">
            <div className="card-head">
              <h2>กระดานรถ</h2>
              <Link href="/fleet" style={{ fontSize: 13, fontWeight: 600 }}>
                รถทั้งหมด →
              </Link>
            </div>
            <div className="card-body">
              {assets.length === 0 ? (
                <Empty>ยังไม่มีรถ · เพิ่มได้ที่ “รถและของ”</Empty>
              ) : (
                <div className={styles.board}>
                  {assets.map((a) => {
                    const inner = (
                      <>
                        <b>{a.code}</b>
                        <small>{a.rentalId && a.dueAt ? (a.state === 'overdue' ? 'เลยกำหนด' : dueText(a.dueAt).replace('คืน ', '')) : STATE_LABEL[a.state]}</small>
                      </>
                    );
                    const style = { background: TILE_BG[a.state], color: TILE_INK[a.state] };
                    return a.rentalId ? (
                      <Link key={a.id} href={`/rentals/${a.rentalId}`} className={styles.vt} style={style} title={`${a.code} · ${STATE_LABEL[a.state]}`}>
                        {inner}
                      </Link>
                    ) : (
                      <span key={a.id} className={styles.vt} style={style} title={`${a.code} · ${STATE_LABEL[a.state]}`}>
                        {inner}
                      </span>
                    );
                  })}
                </div>
              )}
              <div className={styles.legend}>
                {(['available', 'rented', 'overdue', 'maintenance'] as AssetState[]).map((s) => (
                  <span key={s}>
                    <span className={styles.swatch} style={{ background: TILE_BG[s], boxShadow: `inset 0 0 0 1px ${TILE_INK[s]}` }} />
                    {STATE_LABEL[s]} <b>{assets.filter((a) => a.state === s).length}</b>
                  </span>
                ))}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>เงินเข้าวันนี้</h2>
              <b className={styles.money}>{baht(moneyTotal)}</b>
            </div>
            <div className="card-body">
              {(t?.moneyToday ?? []).length === 0 ? (
                <p className="muted">ยังไม่มีการรับเงินวันนี้</p>
              ) : (
                <ul className={styles.moneyList}>
                  {t!.moneyToday.map((m) => (
                    <li key={m.method}>
                      <span>{METHOD_LABEL[m.method]}</span>
                      <b>{baht(m.total)}</b>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function NowCard({ today, now }: { today: Today | null; now: number }) {
  if (!today) return null;
  const o = today.overdue[0];
  if (o) {
    const wa = waLink(o.phone);
    return (
      <section className="now" aria-label="ตอนนี้">
        <span className="now-label">ตอนนี้ · เลยกำหนดคืน {overdueText(o.dueAt, now).replace('เลย ', '')}</span>
        <h2 className={styles.nowTitle}>{o.customerName}</h2>
        <span className="now-sub">
          {o.hotelRoom ? `ห้อง ${o.hotelRoom} · ` : ''}ครบคืน {timeText(o.dueAt)}
          {today.overdue.length > 1 ? ` · ยังมีอีก ${today.overdue.length - 1} สัญญาที่เลยกำหนด` : ''}
        </span>
        <div className={styles.nowActions}>
          {wa && (
            <a className={styles.nowBtn} href={wa} target="_blank" rel="noreferrer">
              ทัก WhatsApp
            </a>
          )}
          <Link className={styles.nowGhost} href={`/rentals/${o.id}`}>
            เปิดสัญญา / รับคืน
          </Link>
        </div>
      </section>
    );
  }
  const u = today.unpaidCheckouts[0];
  if (u) {
    return (
      <section className="now" aria-label="ตอนนี้">
        <span className="now-label">ตอนนี้ · เช็คเอาท์วันนี้ ยังค้างจ่าย</span>
        <h2 className={styles.nowTitle}>
          {u.customerName} · {baht(u.balance)}
        </h2>
        <span className="now-sub">{u.hotelRoom ? `ห้อง ${u.hotelRoom} · ` : ''}เก็บเงินก่อนลูกค้าออกจากโรงแรม</span>
        <div className={styles.nowActions}>
          <Link className={styles.nowBtn} href={`/bills/${u.billId}`}>
            รับเงิน
          </Link>
        </div>
      </section>
    );
  }
  return (
    <section className="now" aria-label="ตอนนี้">
      <span className="now-label">ตอนนี้</span>
      <h2 className={styles.nowTitle}>ไม่มีงานด่วน</h2>
      <span className="now-sub">ไม่มีรถเลยกำหนด และไม่มีบิลเช็คเอาท์ค้างจ่าย</span>
    </section>
  );
}

function FocusList({ focus, today, active, now }: { focus: Focus; today: Today | null; active: RentalSummary[] | null; now: number }) {
  if (!today) return <Empty>กำลังโหลด…</Empty>;
  if (focus === 'unpaid') {
    if (!today.unpaidCheckouts.length) return <Empty>ไม่มีบิลเช็คเอาท์ค้างจ่าย</Empty>;
    return (
      <ul className={styles.rows}>
        {today.unpaidCheckouts.map((u) => (
          <li key={u.billId}>
            <Link href={`/bills/${u.billId}`} className={styles.row}>
              <span className={styles.bar} style={{ background: 'var(--accent)' }} />
              <span className={styles.rowMain}>
                <b>{u.customerName}</b>
                <span className="muted">{u.hotelRoom ? `ห้อง ${u.hotelRoom}` : 'ไม่ได้พักโรงแรม'}</span>
              </span>
              <span className="badge badge-warn">ค้าง {baht(u.balance)}</span>
            </Link>
          </li>
        ))}
      </ul>
    );
  }
  const list =
    focus === 'overdue'
      ? today.overdue
      : focus === 'due'
        ? today.dueToday
        : (active ?? []).map((r) => ({ id: r.id, dueAt: r.dueAt, customerId: r.customerId, customerName: r.customerName, hotelRoom: r.hotelRoom, phone: r.phone, items: r.items }));
  if (!list.length) return <Empty>{focus === 'overdue' ? 'ไม่มีรถเลยกำหนด' : focus === 'due' ? 'ไม่มีรถครบคืนที่เหลือวันนี้' : 'ไม่มีสัญญาที่เช่าอยู่'}</Empty>;
  return (
    <ul className={styles.rows}>
      {list.map((r) => {
        const late = new Date(r.dueAt).getTime() < now;
        // /v1/today ส่งป้ายเป็นข้อความ · /v1/rentals ส่งเป็นรายการของ
        const items = (r.items as Array<string | RentalSummary['items'][number]>)
          .map((i) => (typeof i === 'string' ? i : (i.code ?? i.label)))
          .join(', ');
        return (
          <li key={r.id}>
            <Link href={`/rentals/${r.id}`} className={styles.row}>
              <span className={styles.bar} style={{ background: late ? 'var(--danger)' : 'var(--info-text)' }} />
              <span className={styles.rowMain}>
                <b>{r.customerName}</b>
                <span className="muted">
                  {r.hotelRoom ? `ห้อง ${r.hotelRoom}` : 'ไม่ได้พักโรงแรม'}
                  {items ? ` · ${items}` : ''}
                </span>
              </span>
              <span className={`badge ${late ? 'badge-danger' : 'badge-info'}`}>{late ? overdueText(r.dueAt, now) : dueText(r.dueAt)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
