'use client';

import Link from 'next/link';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useMe } from '@/components/shell';
import { PageHeader, useLoad } from '@/components/ui';
import { api, type AssetType } from '@/lib/api';
import type { SettingsResponse } from '@/lib/api-p2';
import { thb } from '@/lib/api-p3';
import styles from './poster.module.css';

const PRESETS = ['hotel-lobby', 'hotel-room', 'shop-counter'];

/** พิมพ์เฉพาะโปสเตอร์เต็มแผ่น A5 (CSS module ห้าม selector ระดับ body จึงใส่เป็น style ของหน้านี้) */
const PRINT_CSS = `
@page { size: A5; margin: 0; }
@media print {
  body * { visibility: hidden; }
  [data-poster], [data-poster] * { visibility: visible; }
  [data-poster] { position: fixed; inset: 0; max-width: none !important; width: 148mm !important; height: 210mm; border: 0 !important;
    border-radius: 0 !important; padding: 14mm 12mm !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}`;

/** โปสเตอร์ QR หน้าจอง (mock 3.06) · พิมพ์ A5 วางในห้องพัก/ล็อบบี้ · QR ใส่แหล่งที่มาเพื่อดูในรายงาน */
export default function PosterPage() {
  const { me } = useMe();
  const types = useLoad(() => api.get<AssetType[]>('/v1/asset-types').then((r) => r.data));
  const settings = useLoad(() => api.get<SettingsResponse>('/v1/settings').then((r) => r.data));
  const bookingOff = settings.data?.settings.publicBookingEnabled === false;
  const [source, setSource] = useState('hotel-lobby');
  const [origin, setOrigin] = useState('');
  const [svg, setSvg] = useState('');

  useEffect(() => setOrigin(window.location.origin), []);

  const clean = source.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
  const url = origin ? `${origin}/book/${me.org.slug}${clean ? `?src=${encodeURIComponent(clean)}` : ''}` : '';

  useEffect(() => {
    if (!url) return;
    // SVG ที่ไลบรารีสร้างจาก URL ของร้านเอง (ไม่มีข้อความจากผู้ใช้อื่น)
    QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#2a211b', light: '#ffffff' } })
      .then(setSvg)
      .catch(() => setSvg(''));
  }, [url]);

  const priced = (types.data ?? []).filter((t) => t.tracking === 'quantity' || t.unitCount > 0);

  return (
    <div className={styles.page}>
      <div className={styles.controls}>
        <PageHeader
          kicker="ตั้งค่า · พิมพ์ขนาด A5"
          title="โปสเตอร์ QR หน้าจอง"
          actions={
            <button type="button" className="btn btn-primary" onClick={() => window.print()} disabled={!svg}>
              พิมพ์โปสเตอร์
            </button>
          }
        />
        {bookingOff && (
          <div className="alert alert-warn" role="status">
            หน้าจองออนไลน์ยังปิดอยู่ · ลูกค้าสแกน QR แล้วจะเห็นว่า “ร้านไม่รับจองออนไลน์”{' '}
            {me.role === 'owner' ? (
              <Link href="/settings/shop">เปิดที่ “กฎและข้อมูลร้าน”</Link>
            ) : (
              'ให้เจ้าของร้านเปิดก่อนพิมพ์'
            )}
          </div>
        )}
        <div className="card card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label className="field">
            วางที่ไหน (ใส่ใน QR เพื่อดูว่าลูกค้ามาจากช่องทางไหน)
            <input className="input" value={source} maxLength={40} onChange={(e) => setSource(e.target.value)} />
          </label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {PRESETS.map((p) => (
              <button key={p} type="button" className="btn btn-sm" aria-pressed={clean === p} onClick={() => setSource(p)}>
                {p}
              </button>
            ))}
          </div>
          <span className="muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>
            ลิงก์: {url}
          </span>
          <span className="muted" style={{ fontSize: 13 }}>เปลี่ยนราคาในระบบแล้ว พิมพ์ใหม่จากหน้านี้ได้ทันที</span>
        </div>
      </div>

      <style>{PRINT_CSS}</style>
      <section className={styles.poster} aria-label="ตัวอย่างโปสเตอร์" lang="en" data-poster>
        <div className={styles.brand}>
          <span className="sun" aria-hidden="true" />
          <b>{me.org.name}</b>
        </div>
        <h1 className={styles.title}>Rent a scooter, ATV or snorkel gear</h1>
        <p className={styles.sub}>Scan to book in 1 minute · No account · No online payment</p>
        <div className={styles.qr} role="img" aria-label={`QR code to ${url}`} dangerouslySetInnerHTML={{ __html: svg }} />
        <ul className={styles.prices}>
          {priced.map((t) => (
            <li key={t.id}>
              <span>{t.name}</span>
              <b>
                {thb(t.pricePerDay)} <small>/ day</small>
              </b>
            </li>
          ))}
        </ul>
        <p className={styles.foot}>Pay at the shop · Bring your passport and driving licence · Helmets included</p>
      </section>
    </div>
  );
}
