'use client';

import { mediaUrl } from '@/lib/api-p1';
import styles from './asset-visual.module.css';

/** สีพื้นของภาพแทน (ยังไม่มีรูป) ตามสีรถที่บันทึกไว้ */
const TINT: Array<[RegExp, string, string]> = [
  [/ขาว|white/i, '#f4f1ec', '#4a3c33'],
  [/ดำ|black/i, '#3a3532', '#f4f1ec'],
  [/แดง|red/i, '#e9b3a6', '#7e3014'],
  [/ฟ้า|น้ำเงิน|blue/i, '#cfe0ee', '#244e75'],
  [/เขียว|green/i, '#cfe3d2', '#24563a'],
  [/เทา|เงิน|grey|gray|silver/i, '#dcd6cf', '#4a3c33'],
  [/เหลือง|yellow/i, '#f6e7c1', '#6a4b0c'],
  [/ชมพู|pink/i, '#f8d6c6', '#8a3517'],
];

/** ภาพวาดเส้น (ด้านข้าง) · ล้อเป็นวงกลม ส่วนอื่นเป็นเส้น */
const SHAPES: Record<'scooter' | 'atv' | 'gear', { wheels: Array<[number, number, number]>; d: string }> = {
  scooter: {
    wheels: [
      [36, 92, 15],
      [118, 92, 15],
    ],
    d: 'M18 76 Q28 58 62 61 L68 74 L98 81 M50 82 L98 82 M98 82 L108 42 M97 40 L119 36 M104 62 Q118 60 128 80 M30 61 L58 58',
  },
  atv: {
    wheels: [
      [34, 94, 17],
      [118, 94, 17],
    ],
    d: 'M12 78 L44 66 L106 66 L138 78 M56 66 L62 50 L90 50 L96 66 M88 50 L98 33 M89 33 L108 33',
  },
  gear: { wheels: [], d: 'M60 20 L90 20 L100 44 L104 104 L84 104 L76 62 L68 104 L48 104 L50 44 Z M62 20 Q75 34 88 20' },
};

export type VisualKind = 'scooter' | 'atv' | 'gear';

/** เดาท่าทางของภาพแทนจากชื่อประเภท · ของนับจำนวน = อุปกรณ์ */
export function visualKind(typeName: string, tracking: 'unit' | 'quantity' = 'unit'): VisualKind {
  if (tracking === 'quantity') return 'gear';
  return /atv|เอทีวี|quad/i.test(typeName) ? 'atv' : 'scooter';
}

/**
 * รูปรถ/ของ: มีรูปหน้าปก = แสดงรูป · ไม่มี = ภาพวาดแทนตามสีรถ
 * ratio: สัดส่วนกรอบ (4/3 การ์ด · 16/10 popup · 1 รูปย่อ)
 */
export function AssetImage({
  mediaId,
  src,
  kind,
  color,
  alt,
  ratio = 4 / 3,
  caption,
  className,
}: {
  mediaId?: string | null;
  src?: string | null;
  kind: VisualKind;
  color?: string | null;
  alt: string;
  ratio?: number;
  caption?: string;
  className?: string;
}) {
  const url = src ?? (mediaId ? mediaUrl(mediaId) : null);
  const tint = TINT.find(([re]) => re.test(color ?? '')) ?? [null, 'var(--sunk)', 'var(--ink-soft)'];
  return (
    <div className={`${styles.frame} ${className ?? ''}`} style={{ aspectRatio: String(ratio), background: url ? 'var(--sunk)' : tint[1] }}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={alt} loading="lazy" className={styles.img} />
      ) : (
        <svg viewBox="0 0 150 120" className={styles.svg} role="img" aria-label={`${alt} (ยังไม่มีรูป)`} fill="none" stroke={tint[2]} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round">
          {SHAPES[kind].wheels.map(([cx, cy, r]) => (
            <circle key={cx} cx={cx} cy={cy} r={r} />
          ))}
          <path d={SHAPES[kind].d} />
        </svg>
      )}
      {caption && <span className={styles.cap}>{caption}</span>}
    </div>
  );
}
