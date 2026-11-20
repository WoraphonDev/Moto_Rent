'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { messageFor } from '@/lib/messages';
import styles from './ui.module.css';

/** หัวหน้า: บรรทัดเล็ก + ชื่อหน้า + ปุ่มด้านขวา (มือถือปุ่มลงไปบรรทัดใหม่เอง) */
export function PageHeader({ kicker, title, actions }: { kicker?: ReactNode; title: ReactNode; actions?: ReactNode }) {
  return (
    <div className={styles.header}>
      <div style={{ minWidth: 0 }}>
        {kicker && <p className="muted">{kicker}</p>}
        <h1 className={styles.title}>{title}</h1>
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}

export function Notice({ notice }: { notice: { kind: 'ok' | 'danger' | 'warn'; text: string } | null }) {
  if (!notice) return null;
  return (
    <div className={`alert alert-${notice.kind}`} role={notice.kind === 'danger' ? 'alert' : 'status'}>
      {notice.text}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

/** ปุ่ม − / + ขนาดนิ้วโป้ง (≥48px) */
export function Stepper({ value, min, max, onChange, label, unit }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string; unit?: string }) {
  return (
    <div className={styles.stepper} role="group" aria-label={label}>
      <button type="button" className={styles.stepBtn} aria-label={`ลด${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
        −
      </button>
      <span className={styles.stepValue} aria-live="polite">
        <b>{value}</b> {unit && <span className="muted">{unit}</span>}
      </span>
      <button type="button" className={styles.stepBtn} aria-label={`เพิ่ม${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </div>
  );
}

/** กดครั้งแรกถาม กดครั้งที่สองทำจริง · กันกดพลาดโดยไม่ต้องมีหน้าต่างเด้ง */
export function ConfirmButton({ label, danger, onConfirm, className }: { label: string; danger?: boolean; onConfirm: () => void; className?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={className ?? `btn btn-sm${danger ? ' btn-danger' : ''}`}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? `ยืนยัน${label}?` : label}
    </button>
  );
}

/** โหลดข้อมูลจาก API + โหลดใหม่ · error เป็นข้อความไทยพร้อมแสดง */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);
  const reload = useCallback(async () => {
    try {
      setData(await run());
      setError(null);
    } catch (e) {
      setError(messageFor(e));
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload, setData };
}
