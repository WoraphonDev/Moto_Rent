'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AssetCard } from '@/components/asset-card';
import { AssetPopup, GearPopup } from '@/components/asset-popup';
import { AssetImage, visualKind } from '@/components/asset-visual';
import { CoverUpload } from '@/components/cover-upload';
import { Modal, PageSkeleton, Segmented } from '@/components/motion';
import { QrScanner } from '@/components/qr-scanner';
import { useMe } from '@/components/shell';
import { ConfirmButton, Empty, Notice, PageHeader, useLoad } from '@/components/ui';
import { useScanResolver } from '@/components/use-scan';
import { api, type Asset, type AssetState, type AssetType } from '@/lib/api';
import { baht, dueText, overdueText } from '@/lib/format';
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

export default function FleetPageWrap() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <FleetPage />
    </Suspense>
  );
}

/** รถและของ (mock 8.W7 · 9.W2 · 10.W1) · กระเบื้องรูปตามประเภท + popup รายละเอียด */
function FleetPage() {
  const { me } = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const canEdit = me.role === 'owner' || me.role === 'manager';
  const assets = useLoad(() => api.get<Asset[]>('/v1/assets').then((r) => r.data));
  const types = useLoad(() => api.get<AssetType[]>('/v1/asset-types').then((r) => r.data));
  const [filter, setFilter] = useState<Filter>('all');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(params.get('asset'));
  const [fromScan, setFromScan] = useState(params.get('scan') === '1');
  const [gearId, setGearId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(params.get('edit'));
  const [scanning, setScanning] = useState(false);

  const list = useMemo(() => assets.data ?? [], [assets.data]);
  const resolve = useScanResolver(list);
  const unitTypes = (types.data ?? []).filter((t) => t.tracking === 'unit');
  const qtyTypes = (types.data ?? []).filter((t) => t.tracking === 'quantity');
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: list.length, available: 0, rented: 0, overdue: 0, maintenance: 0 };
    for (const a of list) c[a.state]++;
    return c;
  }, [list]);
  const shown = filter === 'all' ? list : list.filter((a) => a.state === filter);
  const groups = unitTypes.map((t) => ({ type: t, items: shown.filter((a) => a.assetTypeId === t.id) })).filter((g) => g.items.length > 0);
  const shownIds = groups.flatMap((g) => g.items.map((a) => a.id));

  // ลิงก์จาก popup (?edit / ?asset) · ล้าง query หลังเปิด
  useEffect(() => {
    if (params.get('edit') || params.get('asset')) router.replace('/fleet', { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!assets.data || !types.data) return assets.error ? <Notice notice={{ kind: 'danger', text: assets.error }} /> : <PageSkeleton />;
  const editing = list.find((a) => a.id === editId) ?? null;

  return (
    <>
      <PageHeader
        kicker={`${list.length} ชิ้น · ว่าง ${counts.available}`}
        title="รถและของ"
        actions={
          <>
            <button type="button" className="btn" onClick={() => setScanning(true)}>
              ⌗ สแกน QR
            </button>
            {canEdit && list.length > 0 && (
              <Link className="btn" href="/fleet/stickers">
                พิมพ์สติกเกอร์ QR
              </Link>
            )}
            {canEdit && unitTypes.length > 0 && (
              <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
                + เพิ่มรถ/ของ
              </button>
            )}
          </>
        }
      />

      <Notice notice={notice ?? (assets.error ? { kind: 'danger', text: assets.error } : null)} />

      <Segmented label="กรองตามสถานะ" value={filter} onChange={setFilter} options={FILTERS.map(([value, label]) => ({ value, label, count: counts[value] }))} />

      {groups.length === 0 && (
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
        <section key={type.id} className="card motion-swap">
          <div className="card-head">
            <h2>
              {type.name} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {items.length} ชิ้น · {baht(type.pricePerDay)}/วัน</span>
            </h2>
          </div>
          <div className="card-body">
            <div className={`${styles.cards} motion-list`}>
              {items.map((a) => (
                <AssetCard
                  key={a.id}
                  asset={a}
                  onSelect={() => {
                    setFromScan(false);
                    setOpenId(a.id);
                  }}
                  sub={
                    a.rentalId ? (
                      <>
                        {a.customerName}
                        {a.dueAt ? ` · ${a.state === 'overdue' ? overdueText(a.dueAt) : dueText(a.dueAt)}` : ''}
                      </>
                    ) : undefined
                  }
                />
              ))}
            </div>
          </div>
        </section>
      ))}

      {qtyTypes.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>อุปกรณ์นับจำนวน</h2>
            <span className="muted" style={{ fontSize: 13 }}>
              ปล่อยเช่าแล้วตัดสต็อกเอง · รับคืนแล้วคืนสต็อกเอง
            </span>
          </div>
          <div className="card-body">
            <div className={`${styles.gear} motion-list`}>
              {qtyTypes.map((t) => {
                const total = t.variants.reduce((s, v) => s + v.quantity, 0);
                const free = t.variants.reduce((s, v) => s + v.available, 0);
                return (
                  <button key={t.id} type="button" className={`${styles.gearCard} motion-lift`} onClick={() => setGearId(t.id)} aria-label={`ดูรายละเอียด ${t.name}`}>
                    <AssetImage mediaId={t.coverMediaId} kind="gear" alt={t.name} />
                    <span className={styles.gearMeta}>
                      <b>{t.name}</b>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {baht(t.pricePerDay)}/วัน
                      </span>
                    </span>
                    <span className={styles.bar}>
                      <span className="motion-bar" style={{ width: `${total ? (free / total) * 100 : 0}%` }} />
                    </span>
                    <span className={styles.chips}>
                      {t.variants.map((v) => (
                        <span key={v.id} className={`badge ${v.available > 0 ? 'badge-neutral' : 'badge-danger'}`}>
                          {v.label} {v.available}/{v.quantity}
                        </span>
                      ))}
                      {t.variants.length === 0 && <span className="muted">ยังไม่มีไซส์</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      )}

      <AssetPopup
        assetId={openId}
        ids={shownIds.includes(openId ?? '') ? shownIds : undefined}
        onNavigate={setOpenId}
        onClose={() => setOpenId(null)}
        fromScan={fromScan}
      />
      <GearPopup typeId={gearId} onClose={() => setGearId(null)} />

      <Modal open={adding} onClose={() => setAdding(false)} title="เพิ่มรถ/ของรายชิ้น" width={640} labelledBy="add-asset-title">
        <AddAsset
          types={unitTypes}
          onDone={async (text, id) => {
            setNotice({ kind: 'ok', text });
            setAdding(false);
            await Promise.all([assets.reload(), types.reload()]);
            if (id) setEditId(id);
          }}
        />
      </Modal>

      <Modal open={!!editing} onClose={() => setEditId(null)} title={editing ? `แก้ไข ${editing.code}` : ''} width={760} labelledBy="edit-asset-title">
        {editing && (
          <EditAsset
            asset={editing}
            type={unitTypes.find((t) => t.id === editing.assetTypeId)}
            onSaved={async (text) => {
              setNotice({ kind: 'ok', text });
              await assets.reload();
            }}
            onClose={() => setEditId(null)}
          />
        )}
      </Modal>

      <QrScanner
        open={scanning}
        onClose={() => setScanning(false)}
        onResult={async (text) => {
          const r = await resolve(text);
          if ('error' in r) return setNotice({ kind: 'danger', text: r.error });
          setScanning(false);
          setFromScan(true);
          setOpenId(r.asset.id);
        }}
      />
    </>
  );
}

function AddAsset({ types, onDone }: { types: AssetType[]; onDone: (text: string, id?: string) => Promise<void> }) {
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
      const { data } = await api.post<{ id: string; code: string }>('/v1/assets', {
        assetTypeId: typeId,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(plate.trim() ? { plate: plate.trim() } : {}),
        ...(color.trim() ? { color: color.trim() } : {}),
        ...(odo !== undefined ? { odometer: odo } : {}),
      });
      await onDone(`เพิ่มแล้ว · รหัส ${data.code} · ถ่ายรูปและพิมพ์สติกเกอร์ QR ได้เลย`, data.id);
    } catch (err) {
      setError(err instanceof Error && err.message === 'odometer' ? 'เลขไมล์ต้องเป็นตัวเลข' : messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="dialog-body" onSubmit={submit}>
      <div className={styles.formGrid}>
        <label className="field">
          ประเภท
          <select className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)} data-autofocus>
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
          <input className="input" maxLength={30} placeholder="เช่น ขาว" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <label className="field">
          เลขไมล์เริ่มต้น
          <input className="input" inputMode="numeric" value={odometer} onChange={(e) => setOdometer(e.target.value)} />
        </label>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        ระบบตั้งรหัสถัดไปให้เอง ({type?.codePrefix ?? ''}…) · ราคาใช้ตามประเภท {type ? baht(type.pricePerDay) : ''}/วัน · บันทึกแล้วตั้งรูปและพิมพ์ QR ต่อได้ทันที
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

/** แก้ไขรถ: ข้อมูล · รูปเฉพาะคัน · สติกเกอร์ QR (mock 9.W4 / 10.W1) */
function EditAsset({ asset, type, onSaved, onClose }: { asset: Asset; type?: AssetType; onSaved: (text: string) => Promise<void>; onClose: () => void }) {
  const [model, setModel] = useState(asset.model ?? '');
  const [plate, setPlate] = useState(asset.plate ?? '');
  const [color, setColor] = useState(asset.color ?? '');
  const [odometer, setOdometer] = useState(asset.odometer === null ? '' : String(asset.odometer));
  const [notes, setNotes] = useState(asset.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const odo = odometer.trim() ? Number(odometer.replace(/[,\s]/g, '')) : undefined;
      if (odo !== undefined && (!Number.isInteger(odo) || odo < 0)) throw new Error('odometer');
      await api.patch(`/v1/assets/${asset.id}`, { model: model.trim(), plate: plate.trim(), color: color.trim(), notes: notes.trim(), ...(odo !== undefined ? { odometer: odo } : {}) });
      await onSaved(`บันทึก ${asset.code} แล้ว`);
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message === 'odometer' ? 'เลขไมล์ต้องเป็นตัวเลข' : messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    try {
      await api.post(`/v1/assets/${asset.id}/qr-token/rotate`);
      await onSaved(`ออก QR ใหม่ให้ ${asset.code} แล้ว · สติกเกอร์เดิมใช้ไม่ได้ทันที พิมพ์ใหม่แล้วติดแทน`);
    } catch (e) {
      setError(messageFor(e));
    }
  }

  return (
    <div className={`dialog-body ${styles.editGrid}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <b>รูปคันนี้</b>
        <CoverUpload
          target={{ assetId: asset.id }}
          mediaId={asset.coverMediaId}
          inherited={!asset.ownCover}
          kind={visualKind(asset.typeName)}
          color={asset.color}
          alt={`${asset.code} ${asset.typeName}`}
          onChanged={() => void onSaved(`อัปเดตรูป ${asset.code} แล้ว`)}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          ไม่ตั้ง = ใช้รูปหน้าปกของ {type?.name ?? 'ประเภท'} (ตั้งที่ ตั้งค่า › ประเภทของให้เช่า) · ตั้งเฉพาะคันเมื่อสีต่างจากรูปหน้าปก
        </span>
        <div className={styles.qrBox}>
          <b>สติกเกอร์ QR</b>
          <span className="muted" style={{ fontSize: 12 }}>
            สติกเกอร์หาย/ถูกแกะ → ออก QR ใหม่ อันเดิมใช้ไม่ได้ทันที
          </span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Link className="btn btn-sm" href={`/fleet/stickers?ids=${encodeURIComponent(asset.id)}`}>
              พิมพ์สติกเกอร์คันนี้
            </Link>
            <ConfirmButton label="ออก QR ใหม่" onConfirm={() => void rotate()} />
          </div>
        </div>
      </div>
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className={styles.formGrid}>
          <label className="field">
            รุ่น
            <input className="input" maxLength={60} value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          <label className="field">
            สี
            <input className="input" maxLength={30} value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <label className="field">
            ทะเบียน
            <input className="input" maxLength={20} value={plate} onChange={(e) => setPlate(e.target.value)} />
          </label>
          <label className="field">
            เลขไมล์
            <input className="input" inputMode="numeric" value={odometer} onChange={(e) => setOdometer(e.target.value)} />
          </label>
        </div>
        <label className="field">
          หมายเหตุ (พนักงานเห็นใน popup)
          <textarea className="input" rows={3} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="เช่น หมวกกันน็อก 2 ใบอยู่ใต้เบาะ" />
        </label>
        {error && (
          <div className="alert alert-danger" role="alert">
            {error}
          </div>
        )}
        <button className="btn btn-primary btn-block card-foot" disabled={busy}>
          {busy ? 'กำลังบันทึก…' : 'บันทึก'}
        </button>
      </form>
    </div>
  );
}
