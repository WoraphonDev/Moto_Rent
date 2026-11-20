'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { mediaUrl, resizeImage, uploadForm, type Media } from '@/lib/api-p1';
import { messageFor } from '@/lib/messages';
import styles from './photo-slots.module.css';

export const PHOTO_SLOTS = [
  { slot: 'front', label: 'ด้านหน้า' },
  { slot: 'back', label: 'ด้านหลัง' },
  { slot: 'left', label: 'ด้านซ้าย' },
  { slot: 'right', label: 'ด้านขวา' },
  { slot: 'odometer', label: 'เลขไมล์' },
  { slot: 'fuel', label: 'เข็มน้ำมัน' },
] as const;

type SlotState = { progress?: number; error?: string; pending?: Blob };

/** รูปรถทุกช่วงของสัญญา (ตอนปล่อย + ตอนรับคืน) · ใช้ร่วมกันหลายการ์ดในหน้าเดียว */
export function useRentalPhotos(rentalId: string) {
  const [photos, setPhotos] = useState<Media[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const { data } = await api.get<Media[]>(`/v1/media?rentalId=${encodeURIComponent(rentalId)}`);
      setPhotos(data.filter((m) => m.kind === 'vehicle_photo'));
      setError(null);
    } catch (e) {
      setError(messageFor(e));
    }
  }, [rentalId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { photos, error, reload };
}

/** รูปล่าสุดของแต่ละมุม ในช่วงที่ระบุ */
export function latestBySlot(photos: Media[], stage: 'checkout' | 'return') {
  const map = new Map<string, Media>();
  for (const p of photos) if (p.stage === stage && p.slot) map.set(p.slot, p);
  return map;
}

/**
 * ถ่ายรูปรถ 6 มุม (mock 1.04 / 1.06)
 * - เปิดกล้องหลังของมือถือได้ทันที · ย่อรูปที่เครื่องก่อนส่ง (ประหยัดเน็ต)
 * - แสดงความคืบหน้า · ส่งไม่สำเร็จกด "ลองอีกครั้ง" ได้โดยไม่ต้องถ่ายใหม่
 * - ตอนรับคืน แสดงรูปตอนปล่อยมุมเดียวกันไว้มุมช่อง เพื่อเทียบรอยใหม่
 */
export function PhotoSlots({
  rentalId,
  stage,
  photos,
  onUploaded,
  readOnly,
}: {
  rentalId: string;
  stage: 'checkout' | 'return';
  photos: Media[];
  onUploaded: () => void;
  readOnly?: boolean;
}) {
  const current = latestBySlot(photos, stage);
  const compare = stage === 'return' ? latestBySlot(photos, 'checkout') : null;
  const [state, setState] = useState<Record<string, SlotState>>({});
  const set = (slot: string, s: SlotState) => setState((x) => ({ ...x, [slot]: s }));

  async function upload(slot: string, original: Blob) {
    set(slot, { progress: 0 });
    let blob: Blob;
    try {
      blob = await resizeImage(original);
    } catch (e) {
      return set(slot, { error: messageFor(e) });
    }
    const form = new FormData();
    form.append('kind', 'vehicle_photo');
    form.append('slot', slot);
    form.append('stage', stage);
    form.append('rentalId', rentalId);
    form.append('file', blob, `${slot}.jpg`);
    try {
      await uploadForm<Media>('/v1/media', form, (p) => set(slot, { progress: p, pending: blob }));
      set(slot, {});
      onUploaded();
    } catch (e) {
      set(slot, { error: messageFor(e), pending: blob });
    }
  }

  return (
    <ul className={styles.grid}>
      {PHOTO_SLOTS.map(({ slot, label }) => {
        const photo = current.get(slot);
        const before = compare?.get(slot);
        const s = state[slot] ?? {};
        const busy = s.progress !== undefined && !s.error;
        const inputId = `photo-${stage}-${slot}`;
        return (
          <li key={slot} className={styles.slot} data-done={!!photo}>
            <div className={styles.frame}>
              {photo ? (
                <img src={mediaUrl(photo.id)} alt={`รูปรถ${label} (${stage === 'checkout' ? 'ตอนปล่อย' : 'ตอนรับคืน'})`} loading="lazy" className={styles.img} />
              ) : (
                <span className={styles.empty} aria-hidden="true">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
                    <circle cx="12" cy="13" r="3.5" />
                  </svg>
                </span>
              )}
              {before && <img src={mediaUrl(before.id)} alt={`รูปตอนปล่อย ${label} สำหรับเทียบ`} className={styles.before} loading="lazy" />}
              {busy && (
                <span className={styles.progress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((s.progress ?? 0) * 100)}>
                  <span style={{ width: `${Math.round((s.progress ?? 0) * 100)}%` }} />
                </span>
              )}
            </div>
            <div className={styles.meta}>
              <span className={styles.label}>
                {label} {photo ? <span className="badge badge-ok">มีแล้ว</span> : <span className="badge badge-warn">ยังไม่มี</span>}
              </span>
              {s.error && (
                <span className={styles.err} role="alert">
                  {s.error}
                </span>
              )}
              {!readOnly && (
                <span className={styles.actions}>
                  {s.error && s.pending ? (
                    <button type="button" className="btn btn-sm" onClick={() => void upload(slot, s.pending!)}>
                      ลองอีกครั้ง
                    </button>
                  ) : null}
                  <label htmlFor={inputId} className={`btn btn-sm${photo ? '' : ' btn-primary'} ${styles.shoot}`} aria-disabled={busy}>
                    {busy ? 'กำลังส่ง…' : photo ? 'ถ่ายใหม่' : 'ถ่ายรูป'}
                  </label>
                  <input
                    id={inputId}
                    className="sr-only"
                    type="file"
                    accept="image/*"
                    capture="environment"
                    disabled={busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) void upload(slot, f);
                    }}
                  />
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
