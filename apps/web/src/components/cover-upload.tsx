'use client';

import { useRef, useState } from 'react';
import { AssetImage, type VisualKind } from '@/components/asset-visual';
import { api } from '@/lib/api';
import { resizeImage, uploadForm } from '@/lib/api-p1';
import { messageFor } from '@/lib/messages';

/**
 * ตั้งรูปหน้าปก (mock 9.W4) · ของประเภท (assetTypeId) หรือเฉพาะคัน (assetId)
 * ย่อรูปในเครื่องก่อนส่ง (เน็ตเกาะช้า) · การวาดใหม่ลงภาพ JPEG ตัดข้อมูลตำแหน่ง (GPS) ออกไปด้วย
 */
export function CoverUpload({
  target,
  mediaId,
  inherited,
  kind,
  color,
  alt,
  onChanged,
}: {
  target: { assetTypeId: string } | { assetId: string };
  mediaId: string | null | undefined;
  /** รูปที่ใช้ตอนนี้มาจากประเภท (ไม่ใช่รูปเฉพาะคัน) */
  inherited?: boolean;
  kind: VisualKind;
  color?: string | null;
  alt: string;
  onChanged: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(0);
    try {
      const blob = await resizeImage(file, 1600, 0.82);
      const form = new FormData();
      form.append('kind', 'cover');
      if ('assetTypeId' in target) form.append('assetTypeId', target.assetTypeId);
      else form.append('assetId', target.assetId);
      form.append('file', blob, 'cover.jpg');
      await uploadForm('/v1/media', form, (p) => setBusy(p));
      onChanged();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  }

  async function remove() {
    setError(null);
    try {
      if ('assetTypeId' in target) await api.patch(`/v1/asset-types/${target.assetTypeId}`, { coverMediaId: null });
      else await api.patch(`/v1/assets/${target.assetId}`, { coverMediaId: null });
      onChanged();
    } catch (e) {
      setError(messageFor(e));
    }
  }

  const own = !!mediaId && !inherited;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <AssetImage mediaId={mediaId} kind={kind} color={color} alt={alt} caption={mediaId ? (inherited ? 'รูปของประเภท' : 'หน้าปก') : undefined} />
      <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="btn btn-sm" style={{ flex: 1 }} disabled={busy !== null} onClick={() => input.current?.click()}>
          {busy !== null ? `กำลังอัปโหลด ${Math.round(busy * 100)}%` : own ? 'เปลี่ยนรูป' : 'ถ่าย / เลือกรูป'}
        </button>
        {own && (
          <button type="button" className="btn btn-sm" onClick={() => void remove()}>
            ลบ
          </button>
        )}
      </div>
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
