'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';

/**
 * พื้น/เส้นใต้ที่เลื่อนตามรายการที่เลือก (mock 8.W2 ข้อ 3)
 * วัดตำแหน่งรายการที่เลือกแล้วตั้ง --ind-x/y/w/h ที่กล่อง · ครั้งแรกวางเลย (ไม่เลื่อน) แล้วค่อยเปิด transition
 */
export function useSlidingIndicator(ref: RefObject<HTMLElement | null>, selector: string, deps: unknown[]) {
  const first = useRef(true);
  const measure = useCallback(() => {
    const box = ref.current;
    if (!box) return;
    const el = box.querySelector<HTMLElement>(selector);
    if (!el) {
      box.style.setProperty('--ind-w', '0px');
      return;
    }
    box.style.setProperty('--ind-x', `${el.offsetLeft}px`);
    box.style.setProperty('--ind-y', `${el.offsetTop}px`);
    box.style.setProperty('--ind-w', `${el.offsetWidth}px`);
    box.style.setProperty('--ind-h', `${el.offsetHeight}px`);
    if (first.current) {
      first.current = false;
      box.setAttribute('data-indicator', 'jump');
      requestAnimationFrame(() => requestAnimationFrame(() => box.setAttribute('data-indicator', 'on')));
    }
  }, [ref, selector]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(measure, [measure, ...deps]);
  useEffect(() => {
    const box = ref.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(box);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [ref, measure]);
}

/** ตัวกรองแบบปุ่มกลุ่ม (พื้นขาวเลื่อนตาม) */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: ReactNode; count?: number }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useSlidingIndicator(ref, "button[aria-pressed='true']", [value, options.length]);
  return (
    <div ref={ref} className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined && <span className="badge badge-neutral">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** แท็บ (เส้นใต้เลื่อนตาม) · เนื้อหาแต่ละแท็บใส่เองข้างนอก */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ value: T; label: ReactNode }>; value: T; onChange: (v: T) => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useSlidingIndicator(ref, "button[aria-selected='true']", [value, tabs.length]);
  return (
    <div ref={ref} className="tabbar" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={t.value === value} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** ตัวเลขนับขึ้นจาก 0 ครั้งแรกที่แสดง (mock 8.W2 ข้อ 6) · ค่าที่เปลี่ยนทีหลังนับจากค่าเดิม */
export function CountUp({ value, format = (n) => n.toLocaleString('en-US'), duration = 1200 }: { value: number; format?: (n: number) => string; duration?: number }) {
  const [shown, setShown] = useState(() => (reducedMotion() ? value : 0));
  const from = useRef(0);
  useEffect(() => {
    if (reducedMotion()) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(a + (value - a) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <span aria-label={format(value)}>{format(shown)}</span>;
}

/** แสดงทีละ N รายการ + ปุ่ม "แสดงอีก" (แม่แบบ A) */
export function useShowMore<T>(items: T[], step = 20) {
  const [limit, setLimit] = useState(step);
  const visible = items.slice(0, limit);
  const rest = Math.max(0, items.length - limit);
  const more =
    rest > 0 ? (
      <button type="button" className="btn btn-sm show-more" onClick={() => setLimit((l) => l + step)}>
        แสดงอีก {Math.min(step, rest)} รายการ <span className="muted">(เหลือ {rest})</span>
      </button>
    ) : null;
  return { visible, more, reset: () => setLimit(step) };
}

/** โครงหน้าระหว่างโหลด แทนข้อความ "กำลังโหลด…" */
export function Skeleton({ h = 16, w = '100%', style }: { h?: number; w?: number | string; style?: CSSProperties }) {
  return <span className="skeleton" aria-hidden="true" style={{ display: 'block', height: h, width: w, ...style }} />;
}

export function PageSkeleton() {
  return (
    <div className="page-frame" aria-busy="true" aria-label="กำลังโหลด">
      <Skeleton h={14} w={180} />
      <Skeleton h={30} w={260} />
      <div className="kpis">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} h={86} />
        ))}
      </div>
      <Skeleton h={280} />
    </div>
  );
}

/**
 * กล่อง popup (mock 9.W2/9.01): คอม = กลางจอ · มือถือ = แผ่นเลื่อนขึ้น
 * ปิดด้วย Esc / กดพื้นหลัง / ปุ่ม × · เล่นท่าปิดก่อนถอดออก · โฟกัสกลับไปที่ปุ่มที่เปิด
 */
export function Modal({
  open,
  onClose,
  title,
  headExtra,
  width = 520,
  children,
  labelledBy = 'modal-title',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  headExtra?: ReactNode;
  width?: number;
  children: ReactNode;
  labelledBy?: string;
}) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (open) {
      opener.current = document.activeElement;
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      setClosing(true);
      const t = setTimeout(() => {
        setMounted(false);
        setClosing(false);
        (opener.current as HTMLElement | null)?.focus?.();
      }, reducedMotion() ? 0 : 250);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && box.current) {
        const f = box.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('[data-autofocus], .dialog-head .icon-btn')?.focus());
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [mounted, onClose]);

  if (!mounted) return null;
  return (
    <div className="overlay" data-closing={closing || undefined} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-labelledby={labelledBy} style={{ '--dialog-w': `${width}px` } as CSSProperties}>
        <span className="sheet-grip" aria-hidden="true" />
        <div className="dialog-head">
          <h2 id={labelledBy}>{title}</h2>
          {headExtra}
          <button type="button" className="icon-btn" aria-label="ปิด" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
