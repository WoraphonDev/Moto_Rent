'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AssetImage, visualKind } from '@/components/asset-visual';
import { Modal, Skeleton } from '@/components/motion';
import { useMe } from '@/components/shell';
import { api } from '@/lib/api';
import type { AssetDetail, GearDetail } from '@/lib/api-assets';
import { baht, dateText, dateTimeText, overdueText } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import styles from './asset-popup.module.css';

const SLOT_LABEL: Record<string, string> = { front: 'หน้า', back: 'หลัง', left: 'ซ้าย', right: 'ขวา', odometer: 'ไมล์', fuel: 'น้ำมัน', damage: 'รอย' };
const STATE: Record<AssetDetail['state'], { label: string; cls: string }> = {
  available: { label: 'ว่าง', cls: 'badge-ok' },
  rented: { label: 'เช่าอยู่', cls: 'badge-info' },
  overdue: { label: 'เลยกำหนด', cls: 'badge-danger' },
  maintenance: { label: 'ซ่อม', cls: 'badge-neutral' },
  retired: { label: 'ปลดระวาง', cls: 'badge-neutral' },
};

/**
 * popup รถ 1 คัน (mock 9.W2 / 10.02 / 10.04)
 * - ids: รายการรถที่เลื่อนดูต่อได้ด้วย ‹ › (เช่น รถว่างทั้งหมดในหน้าปล่อยเช่า)
 * - onPick: แสดงปุ่ม "เลือกคันนี้" (หน้าปล่อยเช่า) · ไม่ใส่ = ปุ่มตามสถานะ (ปล่อยเช่า / รับคืน)
 */
export function AssetPopup({
  assetId,
  ids,
  onNavigate,
  onClose,
  onPick,
  picked,
  fromScan,
}: {
  assetId: string | null;
  ids?: string[];
  onNavigate?: (id: string) => void;
  onClose: () => void;
  onPick?: (id: string) => void;
  picked?: boolean;
  fromScan?: boolean;
}) {
  const { me } = useMe();
  const [d, setD] = useState<AssetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);

  useEffect(() => {
    if (!assetId) return;
    let alive = true;
    setD(null);
    setError(null);
    setPhoto(null);
    api
      .get<AssetDetail>(`/v1/assets/${encodeURIComponent(assetId)}/detail`)
      .then((r) => alive && setD(r.data))
      .catch((e) => alive && setError(messageFor(e)));
    return () => {
      alive = false;
    };
  }, [assetId]);

  const idx = assetId && ids ? ids.indexOf(assetId) : -1;
  const go = (step: number) => {
    if (!ids || idx < 0) return;
    const next = ids[idx + step];
    if (next) onNavigate?.(next);
  };
  useEffect(() => {
    if (!assetId) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const a = d?.asset;
  const kind = a ? visualKind(a.typeName, a.tracking) : 'scooter';
  const st = d ? STATE[d.state] : null;
  const canManage = me.role === 'owner' || me.role === 'manager';
  const big = photo ?? a?.coverMediaId ?? null;

  return (
    <Modal
      open={!!assetId}
      onClose={onClose}
      width={960}
      labelledBy="asset-popup-title"
      title={
        a ? (
          <>
            {a.code} · {a.typeName}
            {a.color ? ` ${a.color}` : ''}
          </>
        ) : (
          'กำลังโหลด…'
        )
      }
      headExtra={
        <>
          {st && <span className={`badge ${st.cls}`}>{st.label}</span>}
          {ids && ids.length > 1 && (
            <span className={styles.nav}>
              <button type="button" className="icon-btn" aria-label="คันก่อนหน้า" disabled={idx <= 0} onClick={() => go(-1)}>
                ‹
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                {idx + 1}/{ids.length}
              </span>
              <button type="button" className="icon-btn" aria-label="คันถัดไป" disabled={idx < 0 || idx >= ids.length - 1} onClick={() => go(1)}>
                ›
              </button>
            </span>
          )}
        </>
      }
    >
      {error && <div className="alert alert-danger" style={{ margin: 16 }}>{error}</div>}
      {!d && !error && (
        <div className={styles.grid}>
          <Skeleton h={300} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} h={22} />
            ))}
          </div>
        </div>
      )}
      {d && a && (
        <div className={`${styles.grid} motion-swap`} key={a.id}>
          <div className={styles.gallery}>
            {fromScan && <span className="badge badge-info" style={{ alignSelf: 'flex-start' }}>สแกนจาก QR ที่รถ</span>}
            <AssetImage mediaId={big} kind={kind} color={a.color} alt={`${a.code} ${a.typeName}`} ratio={16 / 11} caption={photo ? 'สภาพตอนคืนล่าสุด' : a.coverMediaId ? (a.ownCover ? 'รูปคันนี้' : 'รูปหน้าปกของประเภท') : undefined} />
            {d.lastReturnPhotos.length > 0 && (
              <>
                <div className={styles.thumbs} role="group" aria-label="รูปสภาพตอนคืนล่าสุด">
                  <button type="button" className={styles.thumb} aria-pressed={!photo} onClick={() => setPhoto(null)}>
                    <AssetImage mediaId={a.coverMediaId} kind={kind} color={a.color} alt="หน้าปก" ratio={1} caption="หน้าปก" />
                  </button>
                  {d.lastReturnPhotos.map((p) => (
                    <button key={p.mediaId} type="button" className={styles.thumb} aria-pressed={photo === p.mediaId} onClick={() => setPhoto(p.mediaId)}>
                      <AssetImage mediaId={p.mediaId} kind={kind} alt={`สภาพตอนคืน ${SLOT_LABEL[p.slot] ?? p.slot}`} ratio={1} caption={SLOT_LABEL[p.slot] ?? p.slot} />
                    </button>
                  ))}
                </div>
                <span className="muted" style={{ fontSize: 12 }}>
                  สภาพตอนคืนล่าสุด{d.lastReturnAt ? ` · ${dateTimeText(d.lastReturnAt)}` : ''}
                  {d.lastReturnByName ? ` · รับคืนโดย ${d.lastReturnByName}` : ''}
                </span>
              </>
            )}
          </div>

          <div className={styles.info}>
            {d.currentRental && (
              <section className="now" style={{ padding: '12px 14px' }}>
                <span className="now-label">{d.state === 'overdue' ? overdueText(d.currentRental.dueAt) : 'เช่าอยู่'}</span>
                <h3 style={{ fontSize: 17, margin: '4px 0 0' }}>
                  {d.currentRental.customerName}
                  {d.currentRental.room ? ` · ห้อง ${d.currentRental.room}` : ''}
                </h3>
                <span className="now-sub">ครบคืน {dateTimeText(d.currentRental.dueAt)}</span>
              </section>
            )}
            <dl className={styles.kv}>
              {a.plate && (
                <>
                  <dt>ทะเบียน</dt>
                  <dd>{a.plate}</dd>
                </>
              )}
              <dt>ราคา</dt>
              <dd>
                <b>{baht(a.pricePerDay)}</b>/วัน
              </dd>
              {a.odometer !== null && (
                <>
                  <dt>ไมล์</dt>
                  <dd>{a.odometer.toLocaleString('en-US')} กม.</dd>
                </>
              )}
              {d.service.remainingKm !== null && d.service.intervalKm && (
                <>
                  <dt>น้ำมันเครื่อง</dt>
                  <dd>
                    <span className={styles.bar}>
                      <span className="motion-bar" style={{ width: `${Math.max(0, Math.min(100, (d.service.remainingKm / d.service.intervalKm) * 100))}%`, background: d.service.remainingKm < 300 ? 'var(--accent)' : 'var(--primary)' }} />
                    </span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {d.service.remainingKm >= 0 ? `อีก ${d.service.remainingKm.toLocaleString('en-US')} กม. ถึงรอบเปลี่ยน` : `เลยรอบมา ${(-d.service.remainingKm).toLocaleString('en-US')} กม.`}
                    </span>
                  </dd>
                </>
              )}
              {d.damage.length > 0 && (
                <>
                  <dt>รอยเดิม</dt>
                  <dd style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {d.damage.map((x, i) => (
                      <span key={i}>
                        <span className="badge badge-warn">{x.description}</span> <span className="muted" style={{ fontSize: 12 }}>{dateText(x.at)}</span>
                      </span>
                    ))}
                  </dd>
                </>
              )}
              {d.nextBooking && (
                <>
                  <dt>จองไว้</dt>
                  <dd>
                    {d.nextBooking.fullName} · รับ {dateTimeText(d.nextBooking.pickupAt)}
                  </dd>
                </>
              )}
              {a.notes && (
                <>
                  <dt>หมายเหตุ</dt>
                  <dd>{a.notes}</dd>
                </>
              )}
            </dl>

            {d.history.length > 0 && (
              <div>
                <b style={{ fontSize: 13 }}>ประวัติล่าสุด</b>
                <ul className={styles.hist}>
                  {d.history.map((h) => (
                    <li key={h.rentalId}>
                      <Link href={`/rentals/${h.rentalId}`}>
                        {dateText(h.startAt)}
                        {h.returnedAt ? `–${dateText(h.returnedAt)}` : ''} · {h.customerName}
                      </Link>
                      <span className="muted">{h.lateFee > 0 ? `คืนช้า ${baht(h.lateFee)}` : h.status === 'active' ? 'เช่าอยู่' : h.status === 'cancelled' ? 'ยกเลิก' : 'คืนปกติ'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className={styles.actions}>
              {onPick ? (
                <button type="button" className="btn btn-primary" style={{ flex: 1 }} disabled={d.state !== 'available'} onClick={() => onPick(a.id)} data-autofocus>
                  {picked ? 'เอาคันนี้ออก' : d.state === 'available' ? 'เลือกคันนี้' : 'คันนี้ไม่ว่าง'}
                </button>
              ) : d.currentRental ? (
                <>
                  <Link className="btn btn-primary" style={{ flex: 1 }} href={`/rentals/${d.currentRental.id}#return`}>
                    รับคืนคันนี้
                  </Link>
                  <Link className="btn" href={`/rentals/${d.currentRental.id}`}>
                    เปิดสัญญา
                  </Link>
                </>
              ) : d.state === 'available' ? (
                <Link className="btn btn-primary" style={{ flex: 1 }} href={`/checkout?asset=${encodeURIComponent(a.id)}`}>
                  ปล่อยเช่าคันนี้
                </Link>
              ) : null}
              {canManage && (
                <Link className="btn" href={`/maintenance?asset=${encodeURIComponent(a.id)}`}>
                  ส่งซ่อม
                </Link>
              )}
              {canManage && (
                <Link className="btn" href={`/fleet?edit=${encodeURIComponent(a.id)}`}>
                  แก้ไข / รูป / QR
                </Link>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** popup อุปกรณ์นับจำนวน (mock 9.W3) · onPick(variantId) = ใส่ในรายการปล่อยเช่า */
export function GearPopup({ typeId, onClose, onPick }: { typeId: string | null; onClose: () => void; onPick?: (variantId: string) => void }) {
  const [d, setD] = useState<GearDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!typeId) return;
    setD(null);
    setError(null);
    api
      .get<GearDetail>(`/v1/asset-types/${encodeURIComponent(typeId)}/detail`)
      .then((r) => setD(r.data))
      .catch((e) => setError(messageFor(e)));
  }, [typeId]);
  return (
    <Modal open={!!typeId} onClose={onClose} width={780} labelledBy="gear-popup-title" title={d ? <>{d.type.name}{d.type.publicName && <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}> · {d.type.publicName} (ลูกค้าเห็น)</span>}</> : 'กำลังโหลด…'}>
      {error && <div className="alert alert-danger" style={{ margin: 16 }}>{error}</div>}
      {!d && !error && (
        <div className={styles.grid}>
          <Skeleton h={220} />
          <Skeleton h={160} />
        </div>
      )}
      {d && (
        <div className={`${styles.grid} ${styles.gearGrid} motion-swap`}>
          <div className={styles.gallery}>
            <AssetImage mediaId={d.type.coverMediaId} kind="gear" alt={d.type.name} caption={d.type.coverMediaId ? 'หน้าปก' : undefined} />
            <span className="muted" style={{ fontSize: 12 }}>
              {baht(d.type.pricePerDay)}/วัน · ของนับจำนวนใช้รูปหน้าปกต่อประเภท
            </span>
          </div>
          <div className={styles.info}>
            <b style={{ fontSize: 13 }}>ไซส์และจำนวนที่ว่างตอนนี้</b>
            <ul className={`${styles.sizes} motion-list`}>
              {d.variants.map((v) => (
                <li key={v.id}>
                  <b className={styles.sizeLabel}>{v.label}</b>
                  <span className={styles.bar}>
                    <span className="motion-bar" style={{ width: `${v.quantity ? (v.available / v.quantity) * 100 : 0}%` }} />
                  </span>
                  <span className={styles.sizeCount}>
                    ว่าง {v.available} / {v.quantity}
                    {(v.out > 0 || v.booked > 0) && (
                      <span className="muted" style={{ display: 'block', fontSize: 11 }}>
                        {v.out > 0 ? `ออกไป ${v.out}` : ''}
                        {v.out > 0 && v.booked > 0 ? ' · ' : ''}
                        {v.booked > 0 ? `จอง ${v.booked}` : ''}
                      </span>
                    )}
                  </span>
                  {onPick && (
                    <button type="button" className="btn btn-sm" disabled={v.available <= 0} onClick={() => onPick(v.id)}>
                      {v.available > 0 ? '+ เลือก' : 'หมด'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}
