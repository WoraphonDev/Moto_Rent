'use client';

import Link from 'next/link';
import QRCode from 'qrcode';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { PageSkeleton } from '@/components/motion';
import { useMe } from '@/components/shell';
import { Notice, PageHeader, useLoad } from '@/components/ui';
import { api, type Asset, type AssetType } from '@/lib/api';
import { qrLink } from '@/lib/api-assets';
import styles from './stickers.module.css';

type Size = 'm' | 's';

/** พิมพ์เฉพาะแผ่นสติกเกอร์ (CSS module ห้าม selector ระดับ body จึงใส่เป็น style ของหน้านี้) */
const PRINT_CSS = `
@page { size: A4; margin: 10mm; }
@media print {
  body * { visibility: hidden; }
  [data-sheet], [data-sheet] * { visibility: visible; }
  [data-sheet] { position: absolute; left: 0; top: 0; width: 190mm; background: #fff !important; padding: 0 !important; border: 0 !important;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}`;

export default function StickersWrap() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <StickersPage />
    </Suspense>
  );
}

/** สติกเกอร์ QR ติดรถ (mock 10.W1) · รหัสตัวใหญ่อ่านได้แม้ไม่สแกน */
function StickersPage() {
  const { me } = useMe();
  const params = useSearchParams();
  const assets = useLoad(() => api.get<Asset[]>('/v1/assets').then((r) => r.data));
  const types = useLoad(() => api.get<AssetType[]>('/v1/asset-types').then((r) => r.data));
  const only = params.get('ids')?.split(',').filter(Boolean) ?? null;
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [size, setSize] = useState<Size>('m');
  const [svgs, setSvgs] = useState<Record<string, string>>({});

  const list = useMemo(() => (assets.data ?? []).filter((a) => a.qrToken), [assets.data]);
  const unitTypes = (types.data ?? []).filter((t) => t.tracking === 'unit');
  useEffect(() => {
    if (!assets.data || picked) return;
    setPicked(new Set(only ?? list.map((a) => a.id)));
  }, [assets.data, list, only, picked]);

  useEffect(() => {
    let alive = true;
    const origin = window.location.origin;
    void Promise.all(
      list.map(async (a) => [a.id, await QRCode.toString(qrLink(origin, a.qrToken!), { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#2a211b', light: '#ffffff' } })] as const),
    ).then((pairs) => alive && setSvgs(Object.fromEntries(pairs)));
    return () => {
      alive = false;
    };
  }, [list]);

  if (me.role !== 'owner' && me.role !== 'manager') return <Notice notice={{ kind: 'danger', text: 'เฉพาะเจ้าของร้านและผู้จัดการ' }} />;
  if (!assets.data || !types.data || !picked) return <PageSkeleton />;

  const chosen = list.filter((a) => picked.has(a.id));
  const toggleType = (t: AssetType, on: boolean) => {
    const next = new Set(picked);
    for (const a of list.filter((x) => x.assetTypeId === t.id)) on ? next.add(a.id) : next.delete(a.id);
    setPicked(next);
  };

  return (
    <>
      <style>{PRINT_CSS}</style>
      <PageHeader
        kicker={
          <Link href="/fleet" style={{ fontSize: 13 }}>
            ← รถและของ
          </Link>
        }
        title="สติกเกอร์ QR ติดรถ"
        actions={
          <button type="button" className="btn btn-primary" disabled={!chosen.length || Object.keys(svgs).length === 0} onClick={() => window.print()}>
            พิมพ์ {chosen.length} ดวง (A4)
          </button>
        }
      />
      <div className="split">
        <section className="card split-main">
          <div className="card-head">
            <h2>ตัวอย่างแผ่น A4</h2>
            <span className="muted" style={{ fontSize: 12 }}>
              ติดใต้เบาะหรือข้างบังโคลน · พิมพ์บนสติกเกอร์กันน้ำ
            </span>
          </div>
          <div className={`card-body ${styles.sheetWrap}`}>
            <div className={styles.sheet} data-sheet data-size={size}>
              {chosen.map((a) => (
                <div key={a.id} className={styles.sticker}>
                  <span className={styles.qr} dangerouslySetInnerHTML={{ __html: svgs[a.id] ?? '' }} role="img" aria-label={`QR ของ ${a.code}`} />
                  <span className={styles.text}>
                    <span className={styles.shop}>{me.org.name}</span>
                    <b className={styles.code}>{a.code}</b>
                    <span className={styles.hint}>Scan for help · WhatsApp</span>
                  </span>
                </div>
              ))}
              {chosen.length === 0 && <p className="muted">ยังไม่ได้เลือกรถ</p>}
            </div>
          </div>
        </section>
        <aside className="split-side">
          <section className="card">
            <div className="card-head">
              <h2>เลือกที่จะพิมพ์</h2>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {unitTypes.map((t) => {
                const mine = list.filter((a) => a.assetTypeId === t.id);
                if (!mine.length) return null;
                const all = mine.every((a) => picked.has(a.id));
                return (
                  <label key={t.id} className="check">
                    <input type="checkbox" checked={all} onChange={(e) => toggleType(t, e.target.checked)} />
                    {t.name} · {mine.length} คัน
                  </label>
                );
              })}
              <div className={styles.pick}>
                {list.map((a) => (
                  <label key={a.id} className={styles.pickItem}>
                    <input
                      type="checkbox"
                      checked={picked.has(a.id)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        e.target.checked ? next.add(a.id) : next.delete(a.id);
                        setPicked(next);
                      }}
                    />
                    {a.code}
                  </label>
                ))}
              </div>
              <label className="field">
                ขนาด
                <select className="input" value={size} onChange={(e) => setSize(e.target.value as Size)}>
                  <option value="m">กลาง 6 × 3 ซม.</option>
                  <option value="s">เล็ก 4.5 × 2.2 ซม.</option>
                </select>
              </label>
            </div>
          </section>
          <section className="card">
            <div className="card-head">
              <h2>สติกเกอร์หาย / ถูกแกะ</h2>
            </div>
            <div className="card-body">
              <p className="muted" style={{ fontSize: 13 }}>
                เปิดรถคันนั้น › แก้ไข › “ออก QR ใหม่” · QR เดิมใช้ไม่ได้ทันที (กันคนเอาสติกเกอร์เก่าไปแปะคันอื่น) แล้วพิมพ์ใหม่จากหน้านี้
              </p>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
