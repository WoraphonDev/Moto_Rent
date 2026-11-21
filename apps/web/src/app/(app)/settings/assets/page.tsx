'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { visualKind } from '@/components/asset-visual';
import { CoverUpload } from '@/components/cover-upload';
import { useMe } from '@/components/shell';
import { Empty, Notice, PageHeader, useLoad } from '@/components/ui';
import { api, type AssetType, type AssetVariant } from '@/lib/api';
import type { StockAdjustment } from '@/lib/api-p2';
import { baht, dateTimeText, parseBaht } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import styles from './assets.module.css';

type NoticeT = { kind: 'ok' | 'danger'; text: string } | null;

/** ชื่อในร้านเป็นภาษาไทย และยังไม่ได้ตั้งชื่อที่ลูกค้าเห็น → ลูกค้าต่างชาติจะเห็นภาษาไทย */
const needsEnglish = (t: AssetType) => !t.publicName && /[\u0E00-\u0E7F]/.test(t.name);

/** ตั้งค่า · ประเภทของให้เช่า (mock 6.W3 / SAssetTypes) */
export default function AssetTypesPage() {
  const { me } = useMe();
  const canEdit = me.role === 'owner' || me.role === 'manager';
  const types = useLoad(() => api.get<AssetType[]>('/v1/asset-types').then((r) => r.data));
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<NoticeT>(null);

  const list = types.data ?? [];
  const sel = list.find((t) => t.id === selected) ?? list[0] ?? null;
  const missingEnglish = list.filter(needsEnglish).length;

  async function run(action: () => Promise<unknown>, ok: string) {
    setNotice(null);
    try {
      await action();
      setNotice({ kind: 'ok', text: ok });
      await types.reload();
    } catch (e) {
      setNotice({ kind: 'danger', text: messageFor(e) });
    }
  }

  if (!canEdit) {
    return (
      <div className={styles.page}>
        <PageHeader title="ประเภทของให้เช่า" />
        <Notice notice={{ kind: 'danger', text: 'เฉพาะเจ้าของร้านและผู้จัดการ' }} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader
        kicker="ตั้งค่า · แก้ราคาแล้วมีผลกับสัญญาใหม่เท่านั้น · บันทึกในประวัติทุกครั้ง"
        title="ประเภทของให้เช่า"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
            {adding ? 'ปิดฟอร์ม' : '+ เพิ่มประเภท'}
          </button>
        }
      />
      <Notice notice={notice ?? (types.error ? { kind: 'danger', text: types.error } : null)} />
      {missingEnglish > 0 && (
        <div className="alert alert-warn" role="note">
          {missingEnglish} ประเภทยังไม่มีชื่อภาษาอังกฤษ · ลูกค้าต่างชาติบนหน้าจองออนไลน์จะเห็นเป็นภาษาไทย
        </div>
      )}

      {adding && (
        <NewType
          onCreated={async (t) => {
            setAdding(false);
            setSelected(t.id);
            setNotice({ kind: 'ok', text: `เพิ่ม “${t.name}” แล้ว${t.tracking === 'unit' ? ' · เพิ่มรถ/ของรายชิ้นได้ที่หน้า “รถและของ”' : ' · เพิ่มไซส์ด้านขวา'}` });
            await types.reload();
          }}
        />
      )}

      <div className={styles.cols}>
        <section className={`card ${styles.listCard}`}>
          <div className="card-head">
            <h2>
              ประเภททั้งหมด <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {list.length}</span>
            </h2>
            <span className="muted" style={{ fontSize: 12 }}>เลือกเพื่อแก้ไข</span>
          </div>
          {types.data && list.length === 0 ? (
            <Empty>ยังไม่มีประเภท · เริ่มจาก “+ เพิ่มประเภท” เช่น Honda Click 125 (รายชิ้น) หรือ ตีนกบ (นับจำนวน)</Empty>
          ) : (
            <ul className={styles.list}>
              {list.map((t) => (
                <li key={t.id}>
                  <button type="button" className={styles.row} aria-pressed={sel?.id === t.id} onClick={() => setSelected(t.id)}>
                    <span className={styles.rowMain}>
                      <b>{t.name}</b>
                      {t.publicName ? (
                        <span className="muted">ลูกค้าเห็น: {t.publicName}</span>
                      ) : needsEnglish(t) && (
                        <span className="badge badge-warn" style={{ alignSelf: 'flex-start' }}>
                          ยังไม่ตั้งชื่ออังกฤษ · ลูกค้าเห็นภาษาไทย
                        </span>
                      )}
                      <span className="muted">
                        {t.tracking === 'unit' ? `${t.codePrefix ?? ''}… · ${t.unitCount} ชิ้น` : `${t.variants.length} ไซส์ · ${t.variants.reduce((s, v) => s + v.quantity, 0)} ชิ้น`}
                        {t.deposit !== null ? ` · มัดจำ ${baht(t.deposit)}` : ''}
                      </span>
                    </span>
                    <span className={`badge ${t.tracking === 'unit' ? 'badge-info' : 'badge-warn'}`}>{t.tracking === 'unit' ? 'รายชิ้น' : 'นับจำนวน'}</span>
                    <b className={styles.price}>{baht(t.pricePerDay)}/วัน</b>
                    {t.listedOnMarketplace && <span className="badge badge-ok">Marketplace</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {sel && (
          <aside className={styles.side}>
            <EditType key={sel.id} type={sel} run={run} />
            {sel.tracking === 'unit' && <ServiceInterval key={`si-${sel.id}`} type={sel} run={run} />}
            {sel.tracking === 'quantity' && <Variants key={`v-${sel.id}`} type={sel} run={run} />}
            {sel.tracking === 'unit' && (
              <section className="card">
                <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span>
                    มี <b>{sel.unitCount}</b> ชิ้นในประเภทนี้ (รหัส {sel.codePrefix}01, {sel.codePrefix}02 …)
                  </span>
                  <Link className="btn btn-block" href="/fleet">
                    จัดการรถ/ของรายชิ้น →
                  </Link>
                </div>
              </section>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function NewType({ onCreated }: { onCreated: (t: AssetType) => Promise<void> }) {
  const [name, setName] = useState('');
  const [tracking, setTracking] = useState<'unit' | 'quantity'>('unit');
  const [prefix, setPrefix] = useState('');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const minor = parseBaht(price);
    if (minor === null) return setError('ราคาต้องเป็นตัวเลข เช่น 250');
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post<AssetType>('/v1/asset-types', {
        name: name.trim(),
        tracking,
        pricePerDay: minor,
        ...(tracking === 'unit' ? { codePrefix: prefix.trim() } : {}),
      });
      await onCreated(data);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`card ${styles.form}`} onSubmit={submit}>
      <h2 style={{ fontSize: 16 }}>เพิ่มประเภทของให้เช่า</h2>
      <fieldset className={styles.modes}>
        <legend className="field" style={{ marginBottom: 6 }}>
          วิธีนับ
        </legend>
        <label className={styles.mode} data-on={tracking === 'unit'}>
          <input type="radio" name="tracking" checked={tracking === 'unit'} onChange={() => setTracking('unit')} />
          <span>
            <b>รายชิ้น</b>
            <span className="muted">มีรหัส/ทะเบียนทุกชิ้น เช่น รถ ATV</span>
          </span>
        </label>
        <label className={styles.mode} data-on={tracking === 'quantity'}>
          <input type="radio" name="tracking" checked={tracking === 'quantity'} onChange={() => setTracking('quantity')} />
          <span>
            <b>นับจำนวน</b>
            <span className="muted">แยกไซส์ ไม่ต้องติดตามทีละชิ้น เช่น ตีนกบ หน้ากาก</span>
          </span>
        </label>
      </fieldset>
      <div className={styles.formGrid}>
        <label className="field">
          ชื่อประเภท
          <input className="input" required maxLength={60} placeholder={tracking === 'unit' ? 'เช่น Honda Click 125' : 'เช่น ตีนกบ'} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {tracking === 'unit' && (
          <label className="field">
            รหัสนำหน้า
            <input className="input" required maxLength={5} placeholder="เช่น C-" value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} />
          </label>
        )}
        <label className="field">
          ราคาต่อวัน (บาท)
          <input className="input" required inputMode="decimal" placeholder="250" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
      </div>
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
      <button className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'กำลังบันทึก…' : 'บันทึกประเภท'}
      </button>
    </form>
  );
}

function EditType({ type, run }: { type: AssetType; run: (a: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [name, setName] = useState(type.name);
  const [publicName, setPublicName] = useState(type.publicName ?? '');
  const [price, setPrice] = useState(String(type.pricePerDay / 100));
  const [deposit, setDeposit] = useState(type.deposit === null ? '' : String(type.deposit / 100));
  const [error, setError] = useState<string | null>(null);
  const shown = publicName.trim() || name.trim() || type.name;
  const sample = type.tracking === 'quantity' ? type.variants[0]?.label : null;

  function save(e: FormEvent) {
    e.preventDefault();
    const p = parseBaht(price);
    const d = deposit.trim() ? parseBaht(deposit) : null;
    if (!name.trim()) return setError('ใส่ชื่อในร้าน');
    if (p === null || (deposit.trim() && d === null)) return setError('ราคาและมัดจำต้องเป็นตัวเลข');
    setError(null);
    void run(
      () => api.patch(`/v1/asset-types/${type.id}`, { name: name.trim(), publicName: publicName.trim() || null, pricePerDay: p, deposit: d }),
      `บันทึก “${name.trim()}” แล้ว`,
    );
  }

  return (
    <form className="card" onSubmit={save}>
      <div className="card-head">
        <h2>{type.name}</h2>
        <span className={`badge ${type.tracking === 'unit' ? 'badge-info' : 'badge-warn'}`}>{type.tracking === 'unit' ? 'รายชิ้น' : 'นับจำนวน'}</span>
      </div>
      <div className={`card-body ${styles.form}`}>
        <div className={styles.coverRow}>
          <CoverUpload
            target={{ assetTypeId: type.id }}
            mediaId={type.coverMediaId}
            kind={visualKind(type.name, type.tracking)}
            alt={type.name}
            onChanged={() => void run(async () => undefined, `อัปเดตรูปหน้าปก “${type.name}” แล้ว`)}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            รูปหน้าปกใช้กับทุกคันในประเภทนี้ และบนหน้าจองของลูกค้า · คันที่สีต่างตั้งรูปเฉพาะคันได้ที่หน้า “รถและของ”
          </span>
        </div>
        <label className="field">
          ชื่อในร้าน (พนักงานเห็น)
          <input className="input" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          ชื่อที่ลูกค้าเห็น (อังกฤษ)
          <input className="input" maxLength={60} placeholder="เช่น Wetsuit" value={publicName} onChange={(e) => setPublicName(e.target.value)} />
          <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
            ใช้บนหน้าจองออนไลน์ หน้าเซ็นสัญญา และ Marketplace · ว่างไว้ = ใช้ชื่อในร้าน
          </span>
        </label>
        <div className={styles.preview} aria-label="ตัวอย่างที่ลูกค้าเห็น">
          <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>ตัวอย่างที่ลูกค้าเห็น</span>
          <div className={styles.previewItem} lang="en">
            <b>{shown}</b>
            {sample && <span className="muted"> size {sample}</span>}
            <div className="muted" style={{ fontSize: 13 }}>
              {baht(parseBaht(price) ?? type.pricePerDay)} / day
            </div>
          </div>
        </div>
        <div className={styles.formGrid}>
          <label className="field">
            ราคาต่อวัน (บาท)
            <input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
          <label className="field">
            มัดจำ (บาท) <span className="muted" style={{ fontWeight: 400 }}>ว่าง = ไม่เก็บ</span>
            <input className="input" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
          </label>
        </div>
        <dl className={styles.soon}>
          <dt>ราคารายสัปดาห์</dt>
          <dd><span className="badge badge-neutral">เร็วๆ นี้</span></dd>
          <dt>ราคาตามฤดูกาล</dt>
          <dd><span className="badge badge-neutral">เร็วๆ นี้</span></dd>
        </dl>
        {error && (
          <div className="alert alert-danger" role="alert">
            {error}
          </div>
        )}
        <button className="btn btn-primary btn-block">บันทึก</button>

        <div className={styles.switchRow}>
          <span>
            <b>แสดงบน Marketplace</b>
            <span className="muted">Marketplace ยังไม่เปิดตัว · ตั้งไว้ก่อนได้ เมื่อเปิดตัวจะแสดงตามนี้</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={type.listedOnMarketplace}
            aria-label={`แสดง ${type.name} บน Marketplace`}
            className={styles.switch}
            onClick={() =>
              void run(
                () => api.patch(`/v1/asset-types/${type.id}`, { listedOnMarketplace: !type.listedOnMarketplace }),
                type.listedOnMarketplace ? 'ไม่แสดงบน Marketplace แล้ว' : 'ตั้งให้แสดงบน Marketplace แล้ว',
              )
            }
          >
            <span className="sr-only">{type.listedOnMarketplace ? 'เปิด' : 'ปิด'}</span>
          </button>
        </div>
      </div>
    </form>
  );
}

function Variants({ type, run }: { type: AssetType; run: (a: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [label, setLabel] = useState('');
  const [qty, setQty] = useState('');
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const adjustingVariant = type.variants.find((v) => v.id === adjusting) ?? null;

  function add(e: FormEvent) {
    e.preventDefault();
    const n = Number(qty);
    if (!label.trim() || !Number.isInteger(n) || n < 0) return;
    void run(async () => {
      await api.post(`/v1/asset-types/${type.id}/variants`, { label: label.trim(), quantity: n });
      setLabel('');
      setQty('');
    }, `เพิ่มไซส์ ${label.trim()} แล้ว`);
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>ไซส์และจำนวน</h2>
        <span className="muted" style={{ fontSize: 12 }}>เปลี่ยนจำนวนผ่าน “ปรับสต็อก” เท่านั้น (มีเหตุผลและประวัติ)</span>
      </div>
      {type.variants.length === 0 ? (
        <Empty>ยังไม่มีไซส์ · เพิ่มด้านล่าง (ไม่มีไซส์ใช้ “—” ได้)</Empty>
      ) : (
        <ul className={styles.list}>
          {type.variants.map((v) => (
            <VariantRow key={v.id} v={v} active={adjusting === v.id} onAdjust={() => setAdjusting(adjusting === v.id ? null : v.id)} />
          ))}
        </ul>
      )}
      {adjustingVariant && <StockAdjust key={adjustingVariant.id} v={adjustingVariant} run={run} />}
      <form className={`card-body ${styles.addVariant}`} onSubmit={add}>
        <label className="field">
          ไซส์
          <input className="input" maxLength={20} placeholder="S / M / L / —" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="field">
          จำนวน
          <input className="input" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <button className="btn" disabled={!label.trim() || qty.trim() === ''}>
          + เพิ่มไซส์
        </button>
      </form>
    </section>
  );
}

function VariantRow({ v, active, onAdjust }: { v: AssetVariant; active: boolean; onAdjust: () => void }) {
  return (
    <li className={styles.variant}>
      <b className={styles.vLabel}>{v.label}</b>
      <span className="muted" style={{ fontSize: 12 }}>
        ทั้งหมด {v.quantity} · ออกไป {v.out} · ว่าง {v.available}
      </span>
      <button type="button" className="btn btn-sm" aria-pressed={active} onClick={onAdjust}>
        ปรับสต็อก
      </button>
    </li>
  );
}

const REASONS = ['ซื้อเพิ่ม', 'ชำรุด', 'หาย', 'นับใหม่'] as const;

/** ปรับสต็อก (mock 2.01 / 2.W3) · ทุกครั้งต้องมีเหตุผลและเข้าประวัติ · ลดต่ำกว่าของที่ออกไปไม่ได้ */
function StockAdjust({ v, run }: { v: AssetVariant; run: (a: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [reason, setReason] = useState<(typeof REASONS)[number]>('ซื้อเพิ่ม');
  const [amount, setAmount] = useState('1');
  const [note, setNote] = useState('');
  const history = useLoad(() => api.get<StockAdjustment[]>(`/v1/asset-variants/${v.id}/adjustments`).then((r) => r.data), [v.id, v.quantity]);
  const n = Number(amount);
  // นับใหม่ = ใส่จำนวนจริงที่นับได้ · อื่นๆ = ใส่จำนวนที่เพิ่ม/ลด
  const delta = reason === 'นับใหม่' ? n - v.quantity : reason === 'ซื้อเพิ่ม' ? n : -n;
  const next = v.quantity + delta;
  const valid = Number.isInteger(n) && n >= 0 && delta !== 0 && next >= v.out;

  return (
    <form
      className={`card-body ${styles.adjust}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const fullReason = note.trim() ? `${reason}: ${note.trim()}` : reason;
        void run(async () => {
          await api.post(`/v1/asset-variants/${v.id}/adjust`, { delta, reason: fullReason });
          setAmount(reason === 'นับใหม่' ? String(next) : '1');
          setNote('');
        }, `ปรับไซส์ ${v.label}: ${v.quantity} → ${next} ชิ้น`);
      }}
    >
      <h3>ปรับสต็อกไซส์ {v.label}</h3>
      <div className={styles.reasons} role="radiogroup" aria-label="เหตุผล">
        {REASONS.map((r) => (
          <label key={r} className={styles.reason} data-on={reason === r}>
            <input type="radio" name={`reason-${v.id}`} checked={reason === r} onChange={() => setReason(r)} />
            {r}
          </label>
        ))}
      </div>
      <label className="field">
        {reason === 'นับใหม่' ? 'จำนวนที่นับได้จริง' : reason === 'ซื้อเพิ่ม' ? 'เพิ่มกี่ชิ้น' : 'ตัดออกกี่ชิ้น'}
        <input className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />
      </label>
      <label className="field">
        หมายเหตุ <span className="muted" style={{ fontWeight: 400 }}>(ไม่บังคับ)</span>
        <input className="input" maxLength={200} placeholder="เช่น ห้อง 204 ทำหาย" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <p className={next < v.out ? 'alert alert-danger' : 'muted'} style={{ fontSize: 13 }} aria-live="polite">
        {Number.isInteger(n) && delta !== 0
          ? next < v.out
            ? `ลดเหลือ ${next} ไม่ได้ · ลูกค้าเช่าออกไปอยู่ ${v.out} ชิ้น`
            : `${v.quantity} → ${next} ชิ้น (${delta > 0 ? '+' : ''}${delta})`
          : 'ยังไม่มีการเปลี่ยนแปลง'}
      </p>
      <button className="btn btn-primary btn-block" disabled={!valid}>
        บันทึกการปรับสต็อก
      </button>
      {(history.data ?? []).length > 0 && (
        <ul className={styles.history} aria-label="ประวัติการปรับสต็อก">
          {history.data!.map((h) => (
            <li key={h.id}>
              <span className={h.delta > 0 ? 'badge badge-ok' : 'badge badge-danger'}>
                {h.delta > 0 ? '+' : ''}
                {h.delta}
              </span>{' '}
              {h.reason} <span className="muted">· {h.by} · {dateTimeText(h.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

/** รอบเปลี่ยนน้ำมันเครื่องของประเภทนี้ (เฟส 2) · บันทึกเปลี่ยนน้ำมันแล้วระบบตั้งรอบถัดไปให้เอง */
function ServiceInterval({ type, run }: { type: AssetType; run: (a: () => Promise<unknown>, ok: string) => Promise<void> }) {
  // API ส่ง serviceIntervalKm มาพร้อมประเภท (ชนิดข้อมูลกลางยังไม่มีช่องนี้)
  const current = (type as AssetType & { serviceIntervalKm?: number | null }).serviceIntervalKm ?? null;
  const [km, setKm] = useState(current?.toString() ?? '');
  const n = km.trim() === '' ? null : Number(km);
  const valid = n === null || (Number.isInteger(n) && n >= 100 && n <= 100_000);
  return (
    <form
      className={`card card-body ${styles.adjust}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        void run(() => api.patch(`/v1/asset-types/${type.id}/service-interval`, { serviceIntervalKm: n }), n === null ? 'เลิกติดตามรอบน้ำมันเครื่องแล้ว' : `ตั้งรอบน้ำมันเครื่องทุก ${n.toLocaleString()} กม. แล้ว`);
      }}
    >
      <h3>รอบเปลี่ยนน้ำมันเครื่อง</h3>
      <label className="field">
        ทุกกี่ กม. <span className="muted" style={{ fontWeight: 400 }}>(ว่าง = ไม่ติดตาม · ใช้แจ้งเตือนในหน้าซ่อมบำรุง)</span>
        <input className="input" inputMode="numeric" placeholder="เช่น 1000" value={km} onChange={(e) => setKm(e.target.value.replace(/\D/g, ''))} aria-invalid={!valid || undefined} />
      </label>
      <button className="btn" disabled={!valid || n === current}>
        บันทึกรอบ
      </button>
    </form>
  );
}
