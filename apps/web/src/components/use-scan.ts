'use client';

import { useCallback } from 'react';
import { parseScan } from '@/components/qr-scanner';
import { api, ApiError, type Asset } from '@/lib/api';
import { messageFor } from '@/lib/messages';

/**
 * แปลงผลสแกน/รหัสที่พิมพ์ → รถ 1 คัน
 * รหัส (C-03) หาในรายการที่โหลดไว้แล้ว (ใช้ได้ตอนเน็ตหลุด) · ลิงก์ QR ถามเซิร์ฟเวอร์ (เฉพาะรถของร้านนี้)
 */
export function useScanResolver(assets: Asset[]) {
  return useCallback(
    async (text: string): Promise<{ asset: Asset } | { error: string }> => {
      const p = parseScan(text);
      if (!p) return { error: 'ไม่ใช่ QR ของรถในร้าน' };
      if ('code' in p) {
        const norm = (c: string) => c.toUpperCase().replace(/-/g, '');
        const a = assets.find((x) => norm(x.code) === norm(p.code));
        return a ? { asset: a } : { error: `ไม่พบรหัส ${p.code}` };
      }
      const local = assets.find((x) => x.qrToken === p.token);
      if (local) return { asset: local };
      try {
        const { data } = await api.get<{ assetId: string }>(`/v1/assets/by-qr/${encodeURIComponent(p.token)}`);
        const a = assets.find((x) => x.id === data.assetId);
        return a ? { asset: a } : { error: 'รถคันนี้ไม่อยู่ในรายการ (ถูกปลดระวาง?)' };
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return { error: 'QR นี้ใช้ไม่ได้แล้ว หรือเป็นรถของร้านอื่น' };
        return { error: messageFor(e) };
      }
    },
    [assets],
  );
}
