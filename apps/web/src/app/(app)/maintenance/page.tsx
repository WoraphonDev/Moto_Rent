'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMe } from '@/components/shell';
import { Segmented, Skeleton, useShowMore } from '@/components/motion';
import { Empty, Notice, PageHeader, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import type { DueAsset, DueItem, MaintenanceKind, MaintenanceRecord, Urgency } from '@/lib/api-p2';
import { baht, dateText, parseBaht } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import styles from './maintenance.module.css';

type NoticeT = { kind: 'ok' | 'danger'; text: string } | null;

const URGENCY_LABEL: Record<Urgency, string> = { overdue: 'ต้องทำเลย', soon: 'ใกล้ถึง', ok: 'ปกติ' };
const URGENCY_BADGE: Record<Urgency, string> = { overdue: 'badge-danger', soon: 'badge-warn', ok: 'badge-ok' };
const KIND_LABEL: Record<MaintenanceKind, string> = {
  oil: 'เปลี่ยนน้ำมันเครื่อง',
  tire: 'ยาง',
  brake: 'เบรก',
  repair: 'ซ่อม',
  insurance: 'ต่อ พ.ร.บ./ประกัน',
  tax: 'ต่อภาษี',
  other: 'อื่นๆ',
};
const STATUS_LABEL = { available: 'พร้อมให้เช่า', maintenance: 'ส่งซ่อมอยู่', retired: 'ปลดระวาง' } as const;

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ข้อความของสิ่งที่ถึงกำหนด เช่น "น้ำมันเครื่อง · เลยรอบมา 120 กม." */
function dueText(i: DueItem): string {
  if (i.kind === 'oil') {
    return i.remaining <= 0 ? `น้ำมันเครื่อง · เลยรอบมา ${Math.abs(i.remaining).toLocaleString()} กม.` : `น้ำมันเครื่อง · อีก ${i.remaining.toLocaleString()} กม.`;
  }
  const name = i.kind === 'insurance' ? 'พ.ร.บ./ประกัน' : 'ภาษี';
  const on = dateText(String(i.dueAt));
  if (i.remaining < 0) return `${name} · หมดแล้ว ${Math.abs(i.remaining)} วัน (${on})`;
  if (i.remaining === 0) return `${name} · หมดวันนี้`;
  return `${name} · หมดใน ${i.remaining} วัน (${on})`;
}

/** ซ่อมบำรุง (mock 2.02 / 2.W2) */
export default function MaintenancePage() {
  const { me } = useMe();
  const canAdmin = me.role === 'owner' || me.role === 'manager';
  const due = useLoad(() => api.get<{ today: string; assets: DueAsset[] }>('/v1/maintenance/due').then((r) => r.data));
  const records = useLoad(() => api.get<MaintenanceRecord[]>('/v1/maintenance').then((r) => r.data));
  const [filter, setFilter] = useState<Urgency | 'all'>('all');
  const [formAsset, setFormAsset] = useState<string>('');
  const [historyAsset, setHistoryAsset] = useState<string>('');
  const [notice, setNotice] = useState<NoticeT>(null);

  const assets = due.data?.assets ?? [];
  const counts = useMemo(() => ({ overdue: assets.filter((a) => a.urgency === 'overdue').length, soon: assets.filter((a) => a.urgency === 'soon').length, ok: assets.filter((a) => a.urgency === 'ok').length }), [assets]);
  const shown = filter === 'all' ? assets : assets.filter((a) => a.urgency === filter);

  async function run(action: () => Promise<unknown>, ok: string) {
    setNotice(null);
    try {
      await action();
      setNotice({ kind: 'ok', text: ok });
      await Promise.all([due.reload(), records.reload()]);
    } catch (e) {
      setNotice({ kind: 'danger', text: messageFor(e) });
    }
  }

  const month = (due.data?.today ?? localToday()).slice(0, 7);
  const monthCost = useMemo(() => {
    const m = new Map<string, { code: string; cost: number; n: number }>();
    for (const r of records.data ?? []) {
      if (!r.performedOn.startsWith(month)) continue;
      const x = m.get(r.assetId) ?? { code: r.code, cost: 0, n: 0 };
      x.cost += r.cost;
      x.n += 1;
      m.set(r.assetId, x);
    }
    return [...m.values()].sort((a, b) => b.cost - a.cost);
  }, [records.data, month]);

  const history = (records.data ?? []).filter((r) => !historyAsset || r.assetId === historyAsset);
  const dueMore = useShowMore(shown, 8);
  const histMore = useShowMore(history, 5);

  return (
    <div className={styles.page}>
      <PageHeader
        kicker="เตือนก่อนถึงกำหนด · ค่าซ่อมเข้ารายงานกำไรต่อคัน"
        title="ซ่อมบำรุง"
        actions={
          <a className="btn btn-primary" href="#record" onClick={() => setFormAsset('')}>
            + บันทึกงานซ่อม
          </a>
        }
      />
      <Notice notice={notice ?? (due.error ? { kind: 'danger', text: due.error } : null)} />

      <div className="split">
        <div className="split-main">
          <section className="card" aria-label="รถและสิ่งที่ถึงกำหนด">
            <div className={styles.toolbar}>
              <Segmented<Urgency | 'all'>
                label="กรองตามความเร่งด่วน"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: 'ทั้งหมด', count: assets.length },
                  { value: 'overdue', label: 'ต้องทำเลย', count: counts.overdue },
                  { value: 'soon', label: 'ใกล้ถึง', count: counts.soon },
                  { value: 'ok', label: 'ปกติ', count: counts.ok },
                ]}
              />
            </div>
            {!due.data && !due.error && (
              <div className={styles.skel}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} h={52} />
                ))}
              </div>
            )}
            {due.data && shown.length === 0 && <Empty>ไม่มีรายการในกลุ่มนี้</Empty>}
            <div className={`${styles.dueList} motion-list`} key={filter}>
              {dueMore.visible.map((a) => (
                <DueCard
                  key={a.id}
                  asset={a}
                  canAdmin={canAdmin}
                  onRecord={() => {
                    setFormAsset(a.id);
                    document.getElementById('record')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }}
                  run={run}
                />
              ))}
            </div>
            {dueMore.more}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>ประวัติงานซ่อม</h2>
              <label className={styles.inlineField}>
                <span className="muted">รถ</span>
                <select className="input" value={historyAsset} onChange={(e) => setHistoryAsset(e.target.value)}>
                  <option value="">ทุกคัน</option>
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {history.length === 0 ? (
              <Empty>ยังไม่มีประวัติ</Empty>
            ) : (
              <div className="scroll-x">
                <table className="table table-stack">
                  <thead>
                    <tr>
                      <th scope="col">วันที่</th>
                      <th scope="col">รถ</th>
                      <th scope="col">งาน</th>
                      <th scope="col">ไมล์</th>
                      <th scope="col">ค่าใช้จ่าย</th>
                      <th scope="col">บันทึกโดย</th>
                    </tr>
                  </thead>
                  <tbody>
                    {histMore.visible.map((r) => (
                      <tr key={r.id}>
                        <td data-label="วันที่">{dateText(r.performedOn)}</td>
                        <td data-label="รถ">
                          <b>{r.code}</b>
                        </td>
                        <td data-label="งาน">
                          <span className="badge badge-neutral">{KIND_LABEL[r.kind]}</span> {r.description}
                        </td>
                        <td data-label="ไมล์">{r.odometer?.toLocaleString() ?? '—'}</td>
                        <td data-label="ค่าใช้จ่าย">{baht(r.cost)}</td>
                        <td data-label="บันทึกโดย" className="muted">
                          {r.by}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {histMore.more}
          </section>
        </div>

        <aside className="split-side">
          <RecordForm assets={assets} assetId={formAsset} setAssetId={setFormAsset} today={due.data?.today ?? localToday()} run={run} />

          <section className="card">
            <div className="card-head">
              <h2>ค่าซ่อมเดือนนี้</h2>
              <b>{baht(monthCost.reduce((s, x) => s + x.cost, 0))}</b>
            </div>
            {monthCost.length === 0 ? (
              <Empty>ยังไม่มีค่าซ่อมเดือนนี้</Empty>
            ) : (
              <ul className={styles.costList}>
                {monthCost.map((x) => (
                  <li key={x.code}>
                    <span>
                      <b>{x.code}</b> <span className="muted">· {x.n} งาน</span>
                    </span>
                    <b>{baht(x.cost)}</b>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function DueCard({ asset: a, canAdmin, onRecord, run }: { asset: DueAsset; canAdmin: boolean; onRecord: () => void; run: (f: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [ins, setIns] = useState(a.insuranceExpiresOn ?? '');
  const [tax, setTax] = useState(a.taxExpiresOn ?? '');
  const [next, setNext] = useState(a.nextServiceOdometer?.toString() ?? '');
  const items = a.items.filter((i) => i.urgency !== 'ok');

  return (
    <article className={styles.dueCard} data-urgency={a.urgency}>
      <div className={styles.dueHead}>
        <span className={styles.code} data-urgency={a.urgency}>
          {a.code}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{a.typeName}</b> {a.model && <span className="muted">· {a.model}</span>}
          <div className="muted" style={{ fontSize: 13 }}>
            ไมล์ {a.odometer?.toLocaleString() ?? '—'} · {STATUS_LABEL[a.status]}
          </div>
        </div>
        <span className={`badge ${URGENCY_BADGE[a.urgency]}`}>{URGENCY_LABEL[a.urgency]}</span>
      </div>

      {items.length > 0 ? (
        <ul className={styles.dueItems}>
          {items.map((i) => (
            <li key={i.kind}>
              <span className={`badge ${URGENCY_BADGE[i.urgency]}`}>{URGENCY_LABEL[i.urgency]}</span> {dueText(i)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted" style={{ fontSize: 13 }}>
          {a.items.length ? a.items.map(dueText).join(' · ') : 'ยังไม่ได้ตั้งรอบน้ำมันเครื่องหรือวันหมดเอกสาร'}
        </p>
      )}

      <div className={styles.dueActions}>
        <button type="button" className="btn btn-sm" onClick={onRecord}>
          บันทึกงานซ่อม
        </button>
        {canAdmin && a.status !== 'retired' && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              run(
                () => api.patch(`/v1/assets/${a.id}`, { status: a.status === 'maintenance' ? 'available' : 'maintenance' }),
                a.status === 'maintenance' ? `${a.code} พร้อมให้เช่าแล้ว` : `ส่ง ${a.code} ซ่อมแล้ว · หายจากรายการให้เช่า`,
              )
            }
          >
            {a.status === 'maintenance' ? 'พร้อมให้เช่า' : 'ส่งซ่อม'}
          </button>
        )}
        {canAdmin && (
          <button type="button" className="btn btn-sm" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
            แก้กำหนด
          </button>
        )}
      </div>

      {editing && (
        <form
          className={styles.editGrid}
          onSubmit={(e) => {
            e.preventDefault();
            const n = next.trim() === '' ? null : Number(next);
            if (n !== null && (!Number.isInteger(n) || n < 0)) return;
            void run(() => api.patch(`/v1/assets/${a.id}/service-info`, { insuranceExpiresOn: ins || null, taxExpiresOn: tax || null, nextServiceOdometer: n }), `บันทึกกำหนดของ ${a.code} แล้ว`).then(() => setEditing(false));
          }}
        >
          <label className="field">
            พ.ร.บ./ประกัน หมด
            <input className="input" type="date" value={ins} onChange={(e) => setIns(e.target.value)} />
          </label>
          <label className="field">
            ภาษี หมด
            <input className="input" type="date" value={tax} onChange={(e) => setTax(e.target.value)} />
          </label>
          <label className="field">
            เปลี่ยนน้ำมันเครื่องครั้งถัดไปที่ (กม.)
            <input className="input" inputMode="numeric" value={next} onChange={(e) => setNext(e.target.value.replace(/\D/g, ''))} />
          </label>
          <button className="btn btn-primary">บันทึกกำหนด</button>
        </form>
      )}
    </article>
  );
}

function RecordForm({ assets, assetId, setAssetId, today, run }: { assets: DueAsset[]; assetId: string; setAssetId: (v: string) => void; today: string; run: (f: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [kind, setKind] = useState<MaintenanceKind>('oil');
  const [description, setDescription] = useState('');
  const [cost, setCost] = useState('');
  const [odometer, setOdometer] = useState('');
  const [performedOn, setPerformedOn] = useState(today);
  const [newExpiry, setNewExpiry] = useState('');
  const [error, setError] = useState<string | null>(null);
  const asset = assets.find((a) => a.id === assetId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const c = cost.trim() === '' ? 0 : parseBaht(cost);
    if (c === null) return setError('ค่าใช้จ่ายไม่ถูกต้อง');
    if (!assetId) return setError('เลือกรถก่อน');
    const body: Record<string, unknown> = { assetId, kind, description: description.trim() || KIND_LABEL[kind], cost: c, performedOn };
    if (odometer.trim()) body.odometer = Number(odometer);
    if ((kind === 'insurance' || kind === 'tax') && newExpiry) body.newExpiry = newExpiry;
    await run(() => api.post('/v1/maintenance', body), `บันทึก${KIND_LABEL[kind]} ${asset?.code ?? ''} แล้ว`);
    setDescription('');
    setCost('');
    setOdometer('');
    setNewExpiry('');
  }

  return (
    <form id="record" className={`card ${styles.form}`} onSubmit={submit}>
      <h2>บันทึกงานซ่อม</h2>
      <label className="field">
        รถ
        <select className="input" value={assetId} onChange={(e) => setAssetId(e.target.value)} required>
          <option value="">เลือกรถ</option>
          {assets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} · {a.typeName}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        งาน
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as MaintenanceKind)}>
          {(Object.keys(KIND_LABEL) as MaintenanceKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        รายละเอียด
        <input className="input" maxLength={300} placeholder={KIND_LABEL[kind]} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className={styles.twoCol}>
        <label className="field">
          ค่าใช้จ่าย (บาท)
          <input className="input" inputMode="decimal" placeholder="0" value={cost} onChange={(e) => setCost(e.target.value)} />
        </label>
        <label className="field">
          ไมล์ตอนทำ
          <input className="input" inputMode="numeric" placeholder={asset?.odometer?.toString() ?? ''} value={odometer} onChange={(e) => setOdometer(e.target.value.replace(/\D/g, ''))} />
        </label>
      </div>
      <label className="field">
        วันที่ทำ
        <input className="input" type="date" value={performedOn} onChange={(e) => setPerformedOn(e.target.value)} required />
      </label>
      {(kind === 'insurance' || kind === 'tax') && (
        <label className="field">
          วันหมดอายุใหม่
          <input className="input" type="date" value={newExpiry} onChange={(e) => setNewExpiry(e.target.value)} />
        </label>
      )}
      {kind === 'oil' && asset && (
        <p className="muted" style={{ fontSize: 13 }}>
          {asset.serviceIntervalKm ? `รอบถัดไปตั้งให้เองที่ไมล์ตอนทำ + ${asset.serviceIntervalKm.toLocaleString()} กม.` : 'ประเภทนี้ยังไม่ได้ตั้งรอบเปลี่ยนน้ำมัน (ตั้งที่ ประเภทของให้เช่า)'}
        </p>
      )}
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
      <button className="btn btn-primary btn-block">บันทึก</button>
    </form>
  );
}
