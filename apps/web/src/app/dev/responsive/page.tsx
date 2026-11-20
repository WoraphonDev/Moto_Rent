'use client';

import { notFound } from 'next/navigation';
import { useState } from 'react';

/**
 * หน้าตรวจ responsive ตอนพัฒนาเท่านั้น: เปิดหน้าเดียวกันในหลายความกว้างพร้อมกัน
 * (iframe ของเว็บเดียวกัน จึงใช้ cookie ที่เข้าระบบไว้ได้เลย) · production เปิดไม่ได้
 */
const ROUTES = ['/', '/checkout', '/rentals', '/fleet', '/bills', '/customers', '/settings/assets', '/settings/staff', '/more', '/login'];
const WIDTHS = [
  { w: 360, h: 760, label: 'มือถือเล็ก 360' },
  { w: 390, h: 844, label: 'มือถือ 390' },
  { w: 820, h: 1000, label: 'แท็บเล็ต 820' },
  { w: 1280, h: 900, label: 'คอม 1280' },
];

export default function ResponsivePreview() {
  if (process.env.NODE_ENV === 'production') notFound();
  const [route, setRoute] = useState('/');
  const [custom, setCustom] = useState('');
  const src = custom.startsWith('/') ? custom : route;
  return (
    <main style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {ROUTES.map((r) => (
          <button key={r} type="button" className={`btn btn-sm${r === src ? ' btn-primary' : ''}`} onClick={() => { setRoute(r); setCustom(''); }}>
            {r}
          </button>
        ))}
        <input className="input" style={{ maxWidth: 260, minHeight: 32, fontSize: 13 }} placeholder="/rentals/<id>" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="เส้นทางอื่น" />
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', overflowX: 'auto' }}>
        {WIDTHS.map(({ w, h, label }) => {
          const scale = w > 900 ? 0.5 : w > 500 ? 0.55 : 0.8;
          return (
            <figure key={w} style={{ margin: 0, flex: 'none' }}>
              <figcaption className="muted" style={{ fontSize: 12 }}>{label}</figcaption>
              <div style={{ width: w * scale, height: h * scale, overflow: 'hidden', border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }}>
                <iframe title={`${src} @ ${w}`} src={src} style={{ width: w, height: h, border: 0, transform: `scale(${scale})`, transformOrigin: '0 0' }} />
              </div>
            </figure>
          );
        })}
      </div>
    </main>
  );
}
