'use client';

import { useEffect } from 'react';

/**
 * ลงทะเบียน service worker (เปิดแอปได้ตอนเน็ตหลุด) · เฉพาะ production
 * ตอนพัฒนาไม่ลงทะเบียน เพราะ cache ของ service worker ทำให้โค้ดที่แก้ไม่โผล่ทันที
 */
export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}
