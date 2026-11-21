'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AssetCard } from '@/components/asset-card';
import { AssetPopup, GearPopup } from '@/components/asset-popup';
import { AssetImage, visualKind, type VisualKind } from '@/components/asset-visual';
import { CountUp, Segmented, Skeleton } from '@/components/motion';
import { QrScanner } from '@/components/qr-scanner';
import { useMe } from '@/components/shell';
import { Empty, Notice, PageHeader, Stepper, useLoad } from '@/components/ui';
import { useScanResolver } from '@/components/use-scan';
import { api, type Asset, type AssetType, type Customer, type CustomerSummary, type Rental } from '@/lib/api';
import { baht, dateText, newId, STATE_LABEL, timeText } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import type { StaffBooking } from '@/lib/api-p3';
import styles from './checkout.module.css';

interface Picked {
  id: string;
  fullName: string;
  hotelRoom: string | null;
  checkoutDate: string | null;
  doNotRent: boolean;
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ปล่อยเช่า (mock 1.03 / 1.W2 / H.03) · รูปรถ เอกสาร และลายเซ็นมาในเฟสถัดไป */
export default function CheckoutPage() {
  const router = useRouter();
  const { me } = useMe();
  const maxDays = me.settings.maxRentalDays ?? 15;
  const draftId = useRef(newId());

  const [customer, setCustomer] = useState<Picked | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qty, setQty] = useState<Record<string, number>>({});
  const [days, setDays] = useState(1);
  const [paymentMode, setPaymentMode] = useState<'at_checkout' | 'pay_now'>('at_checkout');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'danger' | 'warn' | 'ok'; text: string } | null>(null);
  /** ปล่อยเช่าจากคำขอจอง (เฟส 3) */
  const [booking, setBooking] = useState<{ id: string; code: string } | null>(null);
  const [tab, setTab] = useState<'units' | 'gear'>('units');
  const [search, setSearch] = useState('');
  const [infoId, setInfoId] = useState<string | null>(null);
  const [gearId, setGearId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const assets = useLoad(() => api.get<Asset[]>('/v1/assets').then((r) => r.data));
  const types = useLoad(() => api.get<AssetType[]>('/v1/asset-types').then((r) => r.data));

  // เปิดจากหน้าอื่นพร้อมเลือกลูกค้า/รถไว้แล้ว (?customer=…&asset=…)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const c = params.get('customer');
    const a = params.get('asset');
    const b = params.get('booking');
    if (a) setSelected(new Set([a]));
    if (b) {
      api
        .get<StaffBooking>(`/v1/bookings/${encodeURIComponent(b)}`)
        .then(async ({ data }) => {
          setBooking({ id: data.id, code: data.code });
          setDays(data.days);
          setSelected(new Set(data.items.filter((i) => i.assetId).map((i) => i.assetId as string)));
          setQty(Object.fromEntries(data.items.filter((i) => i.variantId).map((i) => [i.variantId as string, i.quantity])));
          if (data.customerId) {
            const { data: cu } = await api.get<Customer>(`/v1/customers/${data.customerId}`);
            setCustomer({ id: cu.id, fullName: cu.fullName, hotelRoom: cu.hotelRoom, checkoutDate: cu.checkoutDate, doNotRent: cu.doNotRent });
          }
        })
        .catch((e) => setNotice({ kind: 'danger', text: messageFor(e) }));
    }
    if (c) {
      api
        .get<Customer>(`/v1/customers/${encodeURIComponent(c)}`)
        .then(({ data }) => setCustomer({ id: data.id, fullName: data.fullName, hotelRoom: data.hotelRoom, checkoutDate: data.checkoutDate, doNotRent: data.doNotRent }))
        .catch((e) => setNotice({ kind: 'danger', text: messageFor(e) }));
    }
  }, []);

  const available = useMemo(() => (assets.data ?? []).filter((a) => a.state === 'available'), [assets.data]);
  const gearTypes = useMemo(() => (types.data ?? []).filter((t) => t.tracking === 'quantity' && t.variants.length > 0), [types.data]);

  const resolveScan = useScanResolver(assets.data ?? []);
  const lines = useMemo(() => {
    const out: Array<{ key: string; label: string; amount: number; cover: string | null; kind: VisualKind; color: string | null; gear: boolean }> = [];
    for (const a of available.filter((x) => selected.has(x.id))) {
      out.push({ key: a.id, label: `${a.typeName} ${a.code}`, amount: a.pricePerDay * days, cover: a.coverMediaId ?? null, kind: visualKind(a.typeName), color: a.color, gear: false });
    }
    for (const t of gearTypes) {
      for (const v of t.variants) {
        const n = qty[v.id] ?? 0;
        if (n > 0) out.push({ key: v.id, label: `${t.name} ${v.label} × ${n}`, amount: t.pricePerDay * days * n, cover: t.coverMediaId ?? null, kind: 'gear', color: null, gear: true });
      }
    }
    return out;
  }, [available, selected, gearTypes, qty, days]);
  const removeLine = (key: string) => {
    setSelected((s) => {
      const n = new Set(s);
      n.delete(key);
      return n;
    });
    setQty((x) => ({ ...x, [key]: 0 }));
  };
  const total = lines.reduce((s, l) => s + l.amount, 0);

  const due = new Date(Date.now() + days * 86_400_000);
  const pastCheckout = !!customer?.checkoutDate && localDate(due) > customer.checkoutDate;
  const ready = !!customer && !customer.doNotRent && lines.length > 0 && !busy;

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!ready || !customer) return;
    setBusy(true);
    setNotice(null);
    try {
      const items = [
        ...[...selected].filter((id) => available.some((a) => a.id === id)).map((assetId) => ({ assetId })),
        ...Object.entries(qty)
          .filter(([, n]) => n > 0)
          .map(([variantId, quantity]) => ({ variantId, quantity })),
      ];
      const { data } = await api.post<Rental>('/v1/rentals', {
        id: draftId.current,
        customerId: customer.id,
        days,
        paymentMode,
        items,
        // เวลาที่กดจริง · ถ้าเน็ตหลุดแล้วส่งทีหลัง สัญญายังเริ่มตามเวลานี้
        startAt: new Date().toISOString(),
        ...(booking ? { bookingId: booking.id, channel: 'booking_page' } : {}),
      });
      const billId = data.billId;
      router.push(paymentMode === 'pay_now' && billId ? `/bills/${billId}` : `/rentals/${data.id}`);
    } catch (err) {
      setNotice({ kind: 'danger', text: messageFor(err) });
      void assets.reload();
      void types.reload();
      setBusy(false);
    }
  }

  const pickTab = gearTypes.length > 0 ? tab : 'units';
  const q = search.trim().toLowerCase();
  const filtered = q ? available.filter((a) => [a.code, a.color, a.plate, a.model, a.typeName].some((x) => (x ?? '').toLowerCase().includes(q))) : available;
  const availableIds = available.map((a) => a.id);

  /** สแกน/พิมพ์รหัส/ยิงเครื่องสแกน → ใส่รถคันนั้น (ไม่สลับออกถ้าเลือกอยู่แล้ว) */
  async function addByScan(text: string) {
    const r = await resolveScan(text);
    if ('error' in r) return setNotice({ kind: 'danger', text: r.error });
    const a = r.asset;
    if (a.state !== 'available') return setNotice({ kind: 'warn', text: `${a.code} ไม่ว่าง (${STATE_LABEL[a.state]})` });
    setSelected((s) => new Set(s).add(a.id));
    setNotice({ kind: 'ok', text: `เพิ่ม ${a.code} แล้ว` });
    setTab('units');
  }

  return (
    <form onSubmit={submit} className={styles.page}>
      <PageHeader
        kicker="ลูกค้า → รถ/ของ → วันและการจ่าย"
        title="ปล่อยเช่า"
        actions={
          <button type="button" className="btn" onClick={() => setScanning(true)}>
            ⌗ สแกน QR
          </button>
        }
      />
      {booking && (
        <div className="alert alert-ok" role="status">
          จากคำขอจอง <b>{booking.code}</b> · เลือกคันที่กำหนดไว้ให้แล้ว ตรวจแล้วกดยืนยันได้เลย
        </div>
      )}
      <Notice notice={notice} />
      {(assets.error || types.error) && <Notice notice={{ kind: 'danger', text: assets.error ?? types.error ?? '' }} />}

      <div className="split">
        <div className="split-main">
          <CustomerSection customer={customer} onPick={setCustomer} />

          <section className="card" aria-labelledby="sec-items">
            <div className="card-head" style={{ flexWrap: 'wrap' }}>
              <span className={styles.stepHead}>
                <span className={styles.stepNo} data-done={lines.length > 0 || undefined}>
                  {lines.length > 0 ? '✓' : '2'}
                </span>
                <h2 id="sec-items">เลือกรถ / ของ</h2>
              </span>
              {gearTypes.length > 0 && (
                <Segmented
                  label="ชนิดของ"
                  value={pickTab}
                  onChange={setTab}
                  options={[
                    { value: 'units', label: 'รถ', count: available.length },
                    { value: 'gear', label: 'อุปกรณ์', count: gearTypes.length },
                  ]}
                />
              )}
            </div>
            {pickTab === 'units' ? (
              <div className="card-body motion-swap" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <input
                  className="input"
                  type="search"
                  placeholder="ค้นหารหัส สี ทะเบียน · หรือยิงเครื่องสแกน แล้ว Enter"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    if (search.trim()) void addByScan(search).then(() => setSearch(''));
                  }}
                  aria-label="ค้นหารถ"
                />
                {!assets.data && (
                  <div className={styles.cards}>
                    {[0, 1, 2, 3].map((i) => (
                      <Skeleton key={i} h={170} />
                    ))}
                  </div>
                )}
                {assets.data && filtered.length === 0 && <Empty>{available.length === 0 ? 'ไม่มีรถที่ว่างตอนนี้' : 'ไม่พบรถที่ค้นหา'}</Empty>}
                <div className={`${styles.cards} motion-list`}>
                  {filtered.map((a) => (
                    <AssetCard
                      key={a.id}
                      asset={a}
                      selected={selected.has(a.id)}
                      onSelect={() => toggle(a.id)}
                      onInfo={() => setInfoId(a.id)}
                      sub={`${a.typeName}${a.color ? ` · ${a.color}` : ''} · ${baht(a.pricePerDay)}/วัน`}
                    />
                  ))}
                </div>
                <span className="muted" style={{ fontSize: 12 }}>
                  แตะการ์ด = เลือก · ปุ่ม i = ดูรูปสภาพล่าสุดและรายละเอียด · แสดงเฉพาะที่ว่าง
                </span>
              </div>
            ) : (
              <div className="card-body motion-swap">
                <div className={`${styles.gearCards} motion-list`}>
                  {gearTypes.map((t) => (
                    <div key={t.id} className={styles.gearCard}>
                      <button type="button" className={styles.gearImg} onClick={() => setGearId(t.id)} aria-label={`ดูรายละเอียด ${t.name}`}>
                        <AssetImage mediaId={t.coverMediaId} kind="gear" alt={t.name} ratio={16 / 10} />
                      </button>
                      <div className={styles.gearHead}>
                        <b>{t.name}</b>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {baht(t.pricePerDay)}/วัน
                        </span>
                      </div>
                      {t.variants.map((v) => (
                        <div key={v.id} className={styles.gearRow}>
                          <span className={styles.gearLabel}>
                            <b>{v.label}</b>
                            <span className={v.available > 0 ? 'badge badge-ok' : 'badge badge-danger'}>ว่าง {v.available}</span>
                          </span>
                          <Stepper
                            label={`${t.name} ${v.label}`}
                            value={qty[v.id] ?? 0}
                            min={0}
                            max={Math.max(0, v.available)}
                            onChange={(n) => setQty((x) => ({ ...x, [v.id]: n }))}
                          />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="sec-days">
            <div className="card-head">
              <span className={styles.stepHead}>
                <span className={styles.stepNo}>3</span>
                <h2 id="sec-days">จำนวนวัน · วิธีจ่าย</h2>
              </span>
              <span className="muted" style={{ fontSize: 13 }}>
                สูงสุด {maxDays} วัน
              </span>
            </div>
            <div className={`card-body ${styles.daysPay}`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Stepper label="จำนวนวัน" value={days} min={1} max={maxDays} unit="วัน" onChange={setDays} />
                <div className={styles.dueRow}>
                  <span className="muted">คืนรถ</span>
                  <b>
                    {dateText(due.toISOString())} · {timeText(due.toISOString())}
                  </b>
                </div>
                {pastCheckout && (
                  <div className="alert alert-warn" role="alert">
                    คืนหลังวันเช็คเอาท์โรงแรม ({customer?.checkoutDate ? dateText(customer.checkoutDate) : ''}) · ควรเก็บเงินก่อน หรือยืนยันกับลูกค้า
                  </div>
                )}
              </div>
              <div className={styles.payModes} role="radiogroup" aria-label="วิธีจ่าย">
                {(
                  [
                    ['at_checkout', 'จ่ายตอนเช็คเอาท์', 'ยอดเข้าบิลของลูกค้า เก็บทีเดียวตอนออก'],
                    ['pay_now', 'จ่ายเลย', 'ไปหน้ารับเงินทันทีหลังปล่อยเช่า'],
                  ] as const
                ).map(([value, label, hint]) => (
                  <label key={value} className={styles.payOption} data-on={paymentMode === value}>
                    <input type="radio" name="paymentMode" value={value} checked={paymentMode === value} onChange={() => setPaymentMode(value)} />
                    <span>
                      <b>{label}</b>
                      <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                        {hint}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </section>
        </div>

        <aside className="split-side" aria-label="สรุป">
          <section className="card">
            <div className="card-head">
              <h2>สรุป</h2>
              <span className="badge badge-neutral">{days} วัน</span>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className={styles.summaryCustomer}>
                <span className="muted">ลูกค้า</span>
                <b>{customer ? `${customer.fullName}${customer.hotelRoom ? ` · ห้อง ${customer.hotelRoom}` : ''}` : 'ยังไม่ได้เลือก'}</b>
              </div>
              {lines.length === 0 ? (
                <p className="muted" style={{ fontSize: 13 }}>
                  ยังไม่ได้เลือกรถหรืออุปกรณ์
                </p>
              ) : (
                <ul className={`${styles.lines} motion-list`}>
                  {lines.map((l) => (
                    <li key={l.key}>
                      <span className={styles.thumb}>
                        <AssetImage mediaId={l.cover} kind={l.kind} color={l.color} alt={l.label} ratio={1} />
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>{l.label}</span>
                      <b>{baht(l.amount)}</b>
                      <button type="button" className="icon-btn" style={{ width: 32, height: 32, fontSize: 15 }} aria-label={`เอา ${l.label} ออก`} onClick={() => removeLine(l.key)}>
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className={styles.total}>
                <span>รวม</span>
                <b>
                  <CountUp value={total} format={baht} duration={500} />
                </b>
              </div>
              <span className={paymentMode === 'pay_now' ? 'badge badge-info' : 'badge badge-warn'} style={{ alignSelf: 'flex-start' }}>
                {paymentMode === 'pay_now' ? 'จ่ายเลย' : 'จ่ายตอนเช็คเอาท์'}
              </span>
              <button className={`btn btn-primary btn-block ${styles.desktopSubmit}`} disabled={!ready}>
                {busy ? 'กำลังบันทึก…' : 'ยืนยันปล่อยเช่า'}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                ของที่เลือกมีรูปเล็กให้ตรวจถูกคันก่อนยืนยัน
              </span>
            </div>
          </section>
        </aside>
      </div>

      {/* มือถือ: แถบสรุปติดล่าง เหนือแถบเมนูลอย */}
      <div className={styles.mobileBar}>
        <div style={{ minWidth: 0 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            {lines.length} รายการ · {days} วัน
          </span>
          <b className={styles.mobileTotal}>{baht(total)}</b>
        </div>
        <button className="btn btn-primary" style={{ minHeight: 48 }} disabled={!ready}>
          {busy ? 'กำลังบันทึก…' : 'ยืนยันปล่อยเช่า'}
        </button>
      </div>

      <AssetPopup
        assetId={infoId}
        ids={availableIds}
        onNavigate={setInfoId}
        onClose={() => setInfoId(null)}
        picked={!!infoId && selected.has(infoId)}
        onPick={(id) => {
          toggle(id);
          setInfoId(null);
        }}
      />
      <GearPopup
        typeId={gearId}
        onClose={() => setGearId(null)}
        onPick={(variantId) => {
          const v = gearTypes.flatMap((t) => t.variants).find((x) => x.id === variantId);
          setQty((x) => ({ ...x, [variantId]: Math.min(v?.available ?? 0, (x[variantId] ?? 0) + 1) }));
        }}
      />
      <QrScanner open={scanning} onClose={() => setScanning(false)} onResult={(t) => void addByScan(t)} footer={selected.size > 0 ? <div className="alert alert-ok">เลือกแล้ว {selected.size} คัน · สแกนต่อได้</div> : undefined} />
    </form>
  );
}

function CustomerSection({ customer, onPick }: { customer: Picked | null; onPick: (c: Picked | null) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CustomerSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (customer) return;
    const t = setTimeout(() => {
      api
        .get<CustomerSummary[]>(`/v1/customers?q=${encodeURIComponent(q.trim())}`)
        .then(({ data }) => {
          setResults(data);
          setError(null);
        })
        .catch((e) => setError(messageFor(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [q, customer]);

  return (
    <section className="card" aria-labelledby="sec-customer">
      <div className="card-head">
        <span className={styles.stepHead}>
          <span className={styles.stepNo} data-done={customer ? true : undefined}>
            {customer ? '✓' : '1'}
          </span>
          <h2 id="sec-customer">ลูกค้า</h2>
        </span>
        {customer ? (
          <button type="button" className="btn btn-sm" onClick={() => onPick(null)}>
            เปลี่ยน
          </button>
        ) : (
          <button type="button" className="btn btn-sm" onClick={() => setAdding((v) => !v)}>
            {adding ? 'ค้นลูกค้าเก่า' : '+ ลูกค้าใหม่'}
          </button>
        )}
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {customer ? (
          <div className={styles.pickedCustomer}>
            <span className="avatar">{customer.fullName.slice(0, 2).toUpperCase()}</span>
            <div style={{ minWidth: 0 }}>
              <b>{customer.fullName}</b>
              <div className="muted" style={{ fontSize: 13 }}>
                {customer.hotelRoom ? `ห้อง ${customer.hotelRoom}` : 'นอกโรงแรม'}
                {customer.checkoutDate ? ` · เช็คเอาท์ ${dateText(customer.checkoutDate)}` : ''}
              </div>
            </div>
            {customer.doNotRent && <span className="badge badge-danger">ไม่ให้เช่า</span>}
          </div>
        ) : adding ? (
          <NewCustomerForm
            onCreated={(c) => {
              setAdding(false);
              onPick(c);
            }}
          />
        ) : (
          <>
            <label className="field">
              ค้นจากชื่อ ห้อง หรือเบอร์
              <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="เช่น Emma, 204" autoComplete="off" />
            </label>
            {error && <div className="alert alert-danger">{error}</div>}
            <ul className={styles.results}>
              {results.slice(0, 5).map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={styles.resultBtn}
                    disabled={c.doNotRent}
                    onClick={() => onPick({ id: c.id, fullName: c.fullName, hotelRoom: c.hotelRoom, checkoutDate: c.checkoutDate, doNotRent: c.doNotRent })}
                  >
                    <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                      <b>{c.fullName}</b>
                      <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                        {c.hotelRoom ? `ห้อง ${c.hotelRoom}` : 'นอกโรงแรม'}
                        {c.nationality ? ` · ${c.nationality}` : ''}
                        {c.balance > 0 ? ` · ค้าง ${baht(c.balance)}` : ''}
                      </span>
                    </span>
                    {c.doNotRent ? <span className="badge badge-danger">ไม่ให้เช่า</span> : <span className="badge badge-neutral">เลือก</span>}
                  </button>
                </li>
              ))}
              {results.length === 0 && <li className="muted" style={{ fontSize: 13 }}>ไม่พบ · กด “+ ลูกค้าใหม่”</li>}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

function NewCustomerForm({ onCreated }: { onCreated: (c: Picked) => void }) {
  const [fullName, setFullName] = useState('');
  const [nationality, setNationality] = useState('');
  const [phone, setPhone] = useState('');
  const [hotelRoom, setHotelRoom] = useState('');
  const [checkoutDate, setCheckoutDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!fullName.trim()) {
      setError('ใส่ชื่อลูกค้า');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { fullName: fullName.trim() };
      if (nationality.trim()) body.nationality = nationality.trim();
      if (phone.trim()) body.phone = phone.trim();
      if (hotelRoom.trim()) body.hotelRoom = hotelRoom.trim();
      if (checkoutDate) body.checkoutDate = checkoutDate;
      const { data } = await api.post<Customer>('/v1/customers', body);
      onCreated({ id: data.id, fullName: data.fullName, hotelRoom: data.hotelRoom, checkoutDate: data.checkoutDate, doNotRent: data.doNotRent });
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.newCustomer}>
      <label className="field">
        ชื่อตามพาสปอร์ต
        <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={100} />
      </label>
      <label className="field">
        สัญชาติ
        <input className="input" value={nationality} onChange={(e) => setNationality(e.target.value)} maxLength={40} />
      </label>
      <label className="field">
        WhatsApp / เบอร์โทร
        <input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+4512345678" />
      </label>
      <label className="field">
        ห้อง (ถ้าพักโรงแรม)
        <input className="input" value={hotelRoom} onChange={(e) => setHotelRoom(e.target.value)} maxLength={10} />
      </label>
      <label className="field">
        วันเช็คเอาท์โรงแรม
        <input className="input" type="date" value={checkoutDate} onChange={(e) => setCheckoutDate(e.target.value)} />
      </label>
      {error && <div className="alert alert-danger" role="alert" style={{ gridColumn: '1 / -1' }}>{error}</div>}
      <button type="button" className="btn btn-primary" style={{ minHeight: 48, gridColumn: '1 / -1' }} disabled={busy} onClick={create}>
        {busy ? 'กำลังบันทึก…' : 'บันทึกลูกค้าแล้วเลือก'}
      </button>
    </div>
  );
}
