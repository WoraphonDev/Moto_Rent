'use client';

import { useCallback, useEffect, useState } from 'react';
import { rentalReturnedBy, sendQueued } from '@/lib/api';
import { messageFor } from '@/lib/messages';
import { ApiError } from '@/lib/api';
import { flush, isMine, listQueued, OUTBOX_EVENT, removeQueued, type QueuedRequest } from '@/lib/offline';
import styles from './offline-banner.module.css';

const RETRY_MS = 30_000;

/**
 * แถบสถานะออฟไลน์ + รายการที่รอส่ง · ส่งเองเมื่อเน็ตกลับมา (และลองทุก 30 วินาที)
 * รายการที่ถูกปฏิเสธ (เช่น รถถูกเช่าไปแล้วจากอีกเครื่อง) แสดงให้พนักงานเห็นและลบออกได้
 */
export function OfflineBanner() {
  const [online, setOnline] = useState(true);
  const [items, setItems] = useState<QueuedRequest[]>([]);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => setItems(await listQueued()), []);
  const sync = useCallback(async () => {
    await flush(sendQueued, rentalReturnedBy);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) void sync();
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    window.addEventListener(OUTBOX_EVENT, refresh);
    const t = setInterval(() => void sync(), RETRY_MS);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      window.removeEventListener(OUTBOX_EVENT, refresh);
      clearInterval(t);
    };
  }, [refresh, sync]);

  // ของคนอื่นที่เคยเข้าระบบในเครื่องนี้ · ไม่ส่งในนามคนที่เข้าระบบอยู่ รอคนเดิมกลับมา
  const others = items.filter((i) => !isMine(i));
  const pending = items.filter((i) => !i.failed && isMine(i));
  const failed = items.filter((i) => i.failed && isMine(i));
  if (online && items.length === 0) return null;

  const tone = failed.length ? 'danger' : online ? 'ok' : 'warn';
  const otherText = others.length ? ` · รอผู้ใช้เดิม ${others.length}` : '';
  const text = !online
    ? `ออฟไลน์ · รอส่ง ${pending.length} รายการ${otherText}`
    : failed.length
      ? `ส่งไม่สำเร็จ ${failed.length} รายการ${pending.length ? ` · รอส่ง ${pending.length}` : ''}${otherText}`
      : pending.length
        ? `เน็ตกลับมาแล้ว · กำลังส่ง ${pending.length} รายการ${otherText}`
        : `มีรายการของผู้ใช้คนอื่นค้างในเครื่อง ${others.length} รายการ · รอผู้ใช้เดิมเข้าระบบ`;

  return (
    <div className={`${styles.bar} ${styles[tone]}`} role="status" aria-live="polite">
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.text}>{text}</span>
      {items.length > 0 && (
        <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'ซ่อน' : 'ดูรายการ'}
        </button>
      )}
      {open && items.length > 0 && (
        <ul className={styles.list}>
          {items.map((i) => (
            <li key={i.id}>
              <span>
                <b>{i.label}</b> · {new Date(i.createdAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
                {!isMine(i) ? (
                  <span className={styles.err}> · รอผู้ใช้เดิม</span>
                ) : (
                  i.failed && <span className={styles.err}> · {messageFor(new ApiError(i.failed.status, i.failed.code))}</span>
                )}
              </span>
              {i.failed && isMine(i) && (
                <button type="button" className="btn btn-sm btn-danger" onClick={() => void removeQueued(i.id)}>
                  ลบออก
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
