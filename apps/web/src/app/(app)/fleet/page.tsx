'use client';

import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import { useMe } from '@/components/shell';
import { ConfirmButton, Empty, Notice, PageHeader, useLoad } from '@/components/ui';
import { api, type Asset, type AssetState, type AssetType } from '@/lib/api';
import { baht, dueText, overdueText, STATE_BADGE, STATE_LABEL } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import styles from './fleet.module.css';

type Filter = 'all' | AssetState;
const FILTERS: Array<[Filter, string]> = [
  ['all', 'ทั้งหมด'],
  ['available', 'ว่าง'],
  ['rented', 'เช่าอยู่'],
  ['overdue', 'เลยกำหนด'],
  ['maintenance', 'ซ่อม'],
];

/** รถและของ (mock 1.08 / 1.W5) */
export default function FleetPage() {
  const { me } = useMe();
  const canEdit = me.role === 'owner' || me.role === 'manager';
  const assets = useLoad(() => api.get<Asset[]>('/v1/assets').then((r) => r.data));
  const types = useLoad(() => api.get<AssetType[]>('/v1/asset-types').then((r) => r.data));
  const [filter, setFilter] = useState<Filter>('all');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const list = assets.data ?? [];
  const unitTypes = (types.data ?? []).filter((t) => t.tracking === 'unit');
  const qtyTypes = (types.data ?? []).filter((t) => t.tracking === 'quantity');
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: list.length, available: 0, rented: 0, overdue: 0, maintenance: 0 };
    for (const a of list) c[a.state]++;
    return c;
  }, [list]);
  const shown = filter === 'all' ? list : list.filter((a) => a.state === filter);
  const groups = unitTypes
    .map((t) => ({ type: t, items: shown.filter((a) => a.assetTypeId === t.id) }))
    .filter((g) => g.items.length > 0);

  async function setStatus(a: Asset, status: 'available' | 'maintenance') {
    setNotice(null);
    try {
      await api.patch(`/v1/assets/${a.id}`, { status });
      setNotice({ kind: 'ok', text: status === 'maintenance' ? `${a.code} ส่งซ่อมแล้ว · ไม่แสดงในรายการให้เช่า` : `${a.code} พร้อมให้เช่าแล้ว` });
      await assets.reload();
    } catch (e) {
      setNotice({ kind: 'danger', text: messageFor(e) });
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader
        kicker={`${list.length} ชิ้น · ว่าง ${counts.available}`}
        title="รถและของ"
        actions={
          canEdit && unitTypes.length > 0 ? (
            <button type="button" className="btn btn-primary" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
              {adding ? 'ปิดฟอร์ม' : '+ เพิ่มรถ/ของรายชิ้น'}
            </button>
          ) : undefined
        }
      />

      <Notice notice={notice ?? (assets.error ? { kind: 'danger', text: assets.error } : null)} />

      {adding && canEdit && (
        <AddAsset
          types={unitTypes}
          onDone={async (text) => {
            setNotice({ kind: 'ok', text });
            setAdding(false);
            await Promise.all([assets.reload(), types.reload()]);
          }}
        />
      )}

      <div className={styles.chips} role="group" aria-label="กรองตามสถานะ">
        {FILTERS.map(([k, label]) => (
          <button key={k} type="button" className={styles.chip} aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label} <span className={styles.chipN}>{counts[k]}</span>
          </button>
        ))}
      </div>

      {assets.data && groups.length === 0 && (
        <section className="card">
          <Empty>
            {list.length === 0 ? (
              <>
                ยังไม่มีรถ/ของรายชิ้น{canEdit ? <> · ตั้งประเภทก่อนที่ <Link href="/settings/assets">ประเภทของให้เช่า</Link></> : ''}
              </>
            ) : (
              'ไม่มีรายการในสถานะนี้'
            )}
          </Empty>
        </section>
      )}

      {groups.map(({ type, items }) => (
        <section key={type.id} className="card">
          <div className="card-head">
            <h2>
              {type.name} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {items.length} ชิ้น · {baht(type.pricePerDay)}/วัน</span>
            </h2>
          </div>
          <ul className={styles.list}>
            {items.map((a) => (
              <li key={a.id} className={styles.item}>
                <span className={styles.code} data-state={a.state}>
                  {a.code}
                </span>
                <div className={styles.info}>
                  <b>{[a.model, a.color].filter(Boolean).join(' · ') || a.typeName}</b>
                  <span className="muted">
                    {a.plate ? `ทะเบียน ${a.plate}` : 'ไม่มีทะเบียน'}
                    {a.odometer !== null ? ` · ไมล์ ${a.odometer.toLocaleString('en-US')}` : ''}
                    {a.pricePerDay !== type.pricePerDay ? ` · ราคาเฉพาะคัน ${baht(a.pricePerDay)}` : ''}
                  </span>
                </div>
                <div className={styles.renter}>
                  {a.rentalId ? (
                    <Link href={`/rentals/${a.rentalId}`}>
                      <b>{a.customerName}</b>
                      <span className="muted">
                        {a.hotelRoom ? `ห้อง ${a.hotelRoom} · ` : ''}
                        {a.dueAt ? (a.state === 'overdue' ? overdueText(a.dueAt) : dueText(a.dueAt)) : ''}
                      </span>
                    </Link>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </div>
                <span className={`badge ${STATE_BADGE[a.state]} ${styles.state}`}>{STATE_LABEL[a.state]}</span>
                {canEdit && !a.rentalId && (
                  <span className={styles.act}>
                    {a.status === 'maintenance' ? (
                      <button type="button" className="btn btn-sm" onClick={() => setStatus(a, 'available')}>
                        พร้อมให้เช่า
                      </button>
                    ) : (
                      <ConfirmButton label="ส่งซ่อม" onConfirm={() => void setStatus(a, 'maintenance')} />
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {qtyTypes.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>อุปกรณ์นับจำนวน</h2>
            <span className="muted" style={{ fontSize: 13 }}>ปล่อยเช่าแล้วตัดสต็อกเอง · รับคืนแล้วคืนสต็อกเอง</span>
          </div>
          <div className="card-body">
            <div className={styles.stockGrid}>
              {qtyTypes.map((t) => (
                <div key={t.id} className={styles.stock}>
                  <h3 className={styles.stockTitle}>
                    {t.name} <span className="muted" style={{ fontWeight: 400 }}>{baht(t.pricePerDay)}/วัน</span>
                  </h3>
                  {t.variants.length === 0 ? (
                    <p className="muted" style={{ fontSize: 13 }}>ยังไม่มีไซส์</p>
                  ) : (
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">ไซส์</th>
                          <th scope="col">ทั้งหมด</th>
                          <th scope="col">ออกไป</th>
                          <th scope="col">ว่าง</th>
                        </tr>
                      </thead>
                      <tbody>
                        {t.variants.map((v) => (
                          <tr key={v.id}>
                            <td>
                              <b>{v.label}</b>
                            </td>
                            <td>{v.quantity}</td>
                            <td>{v.out}</td>
                            <td>
                              <span className={`badge ${v.available > 0 ? 'badge-ok' : 'badge-danger'}`}>{v.available > 0 ? `ว่าง ${v.available}` : 'หมด'}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function AddAsset({ types, onDone }: { types: AssetType[]; onDone: (text: string) => Promise<void> }) {
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [model, setModel] = useState('');
  const [plate, setPlate] = useState('');
  const [color, setColor] = useState('');
  const [odometer, setOdometer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const type = types.find((t) => t.id === typeId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const odo = odometer.trim() ? Number(odometer.replace(/[,\s]/g, '')) : undefined;
      if (odo !== undefined && (!Number.isInteger(odo) || odo < 0)) throw new Error('odometer');
      const { data } = await api.post<{ code: string }>('/v1/assets', {
        assetTypeId: typeId,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(plate.trim() ? { plate: plate.trim() } : {}),
        ...(color.trim() ? { color: color.trim() } : {}),
        ...(odo !== undefined ? { odometer: odo } : {}),
      });
      await onDone(`เพิ่มแล้ว · รหัส ${data.code} (พิมพ์สติกเกอร์ QR ได้ในเฟสถัดไป)`);
    } catch (err) {
      setError(err instanceof Error && err.message === 'odometer' ? 'เลขไมล์ต้องเป็นตัวเลข' : messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`card ${styles.form}`} onSubmit={submit}>
      <h2 style={{ fontSize: 16 }}>เพิ่มรถ/ของรายชิ้น</h2>
      <div className={styles.formGrid}>
        <label className="field">
          ประเภท
          <select className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.codePrefix}…)
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          รุ่น
          <input className="input" maxLength={60} placeholder="เช่น Click 125" value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label className="field">
          ทะเบียน
          <input className="input" maxLength={20} value={plate} onChange={(e) => setPlate(e.target.value)} />
        </label>
        <label className="field">
          สี
          <input className="input" maxLength={30} value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <label className="field">
          เลขไมล์เริ่มต้น
          <input className="input" inputMode="numeric" value={odometer} onChange={(e) => setOdometer(e.target.value)} />
        </label>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        ระบบตั้งรหัสถัดไปให้เอง ({type?.codePrefix ?? ''}…) · ราคาใช้ตามประเภท {type ? baht(type.pricePerDay) : ''}/วัน
      </p>
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
      <button className="btn btn-primary btn-block" disabled={busy || !typeId}>
        {busy ? 'กำลังบันทึก…' : 'บันทึก'}
      </button>
    </form>
  );
}
