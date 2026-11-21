'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, type LoginResponse, type Me, type Role } from '@/lib/api';
import { messageFor, ROLE_LABEL } from '@/lib/messages';
import { clearOutbox, listQueued, setOutboxOwner } from '@/lib/offline';
import { PageSkeleton, useSlidingIndicator } from '@/components/motion';
import { ACTIVITY_KEY, LOCK_KEY, readLocal, writeLocal } from '@/lib/storage';

import styles from './shell.module.css';

const MeContext = createContext<{ me: Me; reload: () => Promise<void>; logout: () => void } | null>(null);

export function useMe() {
  const v = useContext(MeContext);
  if (!v) throw new Error('useMe outside Shell');
  return v;
}

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  roles?: Role[];
  /** แสดงในแถบเมนูล่างของมือถือ (สูงสุด 4 + เมนู) */
  mobile?: boolean;
  section?: 'admin';
}

const icon = (d: string) => (
  <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

export const NAV: NavItem[] = [
  { href: '/', label: 'หน้าหลัก', icon: icon('M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z'), mobile: true },
  { href: '/checkout', label: 'ปล่อยเช่า', icon: icon('M12 5v14M5 12h14'), mobile: true },
  { href: '/rentals', label: 'สัญญา / รับคืน', icon: icon('M9 14l-5-5 5-5M4 9h11a5 5 0 0 1 0 10h-3') },
  { href: '/fleet', label: 'รถและของ', icon: icon('M6 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM9 17h6l-3-8H9M15 9h3l2 8'), mobile: true },
  { href: '/bills', label: 'บิล', icon: icon('M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6'), mobile: true },
  { href: '/customers', label: 'ลูกค้า', icon: icon('M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM3 21c0-3.5 2.7-6 6-6s6 2.5 6 6') },
  { href: '/bookings', label: 'การจอง', icon: icon('M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M8 3v4M16 3v4') },
  { href: '/day-close', label: 'ปิดยอดสิ้นวัน', icon: icon('M4 7h16v10H4zM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4M7 10v.01M17 14v.01') },
  { href: '/maintenance', label: 'ซ่อมบำรุง', icon: icon('M14 6a4 4 0 0 0 5 5l-9 9-3-3 9-9a4 4 0 0 1-2-2z') },
  { href: '/reports', label: 'รายงาน', icon: icon('M4 20V10M10 20V4M16 20v-7M21 20H3'), roles: ['owner', 'manager'] },
  { href: '/audit', label: 'ประวัติการใช้งาน', icon: icon('M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'), roles: ['owner', 'manager'] },
  { href: '/settings/shop', label: 'กฎและข้อมูลร้าน', icon: icon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .5-1.5-1.5.5-2-3-1-1 2h-2l-1-2-3 1 .5 2L6 7.5 4 7 3 10l2 1v2l-2 1 1 3 2-.5L7.5 18 7 20l3 1 1-2h2l1 2 3-1-.5-2 1.5-1.5 2 .5 1-3-2-1z'), roles: ['owner'], section: 'admin' },
  { href: '/settings/assets', label: 'ประเภทของให้เช่า', icon: icon('M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1'), roles: ['owner', 'manager'], section: 'admin' },
  {
    href: '/settings/staff',
    label: 'พนักงานและเครื่อง',
    icon: icon('M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM3 21c0-3.5 2.7-6 6-6s6 2.5 6 6M16 3.5a4 4 0 0 1 0 7.5M18 15c2 .7 3 2.8 3 6'),
    roles: ['owner', 'manager'],
    section: 'admin',
  },
  { href: '/settings/messages', label: 'ข้อความ WhatsApp', icon: icon('M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.2A8.5 8.5 0 1 1 21 12z'), roles: ['owner', 'manager'], section: 'admin' },
  { href: '/settings/poster', label: 'โปสเตอร์ QR หน้าจอง', icon: icon('M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2'), roles: ['owner', 'manager'], section: 'admin' },
];

export const MENU_ICON = icon('M4 7h16M4 12h16M4 17h16');

export function initials(name: string) {
  return name.trim().slice(0, 2).toUpperCase();
}

/** โครงหน้าหลังเข้าระบบ: เว็บ = แถบบนเข้ม + เมนูข้างขาว · มือถือ = แถบเมนูล่างสีเข้ม */
/** ออกจากระบบจริง: ปิด session แล้วล้างกล่องรอส่ง (เครื่องหน้าร้านใช้ร่วมกัน รายการของคนหนึ่งต้องไม่ถูกส่งในชื่ออีกคน) */
async function signOut(): Promise<void> {
  await api.post('/v1/auth/logout').catch(() => undefined);
  setOutboxOwner(null, null);
  await clearOutbox();
}

/** รายการออฟไลน์ที่ยังรอส่ง แยกตามชนิด เช่น "ปล่อยเช่า 1 · รับเงิน 1" */
async function pendingSummary(): Promise<{ n: number; text: string }> {
  const items = (await listQueued().catch(() => [])).filter((i) => !i.failed);
  const by = new Map<string, number>();
  for (const i of items) by.set(i.label, (by.get(i.label) ?? 0) + 1);
  return { n: items.length, text: [...by].map(([k, v]) => `${k} ${v}`).join(' · ') };
}

export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  // ล็อกจอต้องอยู่ต่อแม้รีโหลดหน้า/เปิดแท็บใหม่ (เดิมรีโหลดแล้วหลุดล็อก) · จำไว้ในเครื่อง
  const [locked, setLockedState] = useState(() => typeof window !== 'undefined' && readLocal(LOCK_KEY) === '1');
  const setLocked = useCallback((v: boolean) => {
    writeLocal(LOCK_KEY, v ? '1' : null);
    if (!v) writeLocal(ACTIVITY_KEY, String(Date.now()));
    setLockedState(v);
  }, []);
  const [online, setOnline] = useState(true);
  const [confirmOut, setConfirmOut] = useState<{ n: number; text: string } | null>(null);
  const sideRef = useRef<HTMLElement>(null);
  const bottomRef = useRef<HTMLElement>(null);
  useSlidingIndicator(sideRef, "a[aria-current='page']", [pathname, !!me]);
  useSlidingIndicator(bottomRef, "a[aria-current='page']", [pathname, !!me]);

  const reload = useCallback(async () => {
    try {
      const { data } = await api.get<Me>('/v1/auth/me');
      // เครื่องยังอยู่ในโหมดลูกค้า (ลูกค้าพิมพ์ URL อื่น) · พากลับหน้าเซ็นสัญญา ไม่โชว์เมนูพนักงาน
      if (data.customerModeRentalId) {
        router.replace(`/sign/${data.customerModeRentalId}`);
        return;
      }
      // กล่องรอส่งออฟไลน์ผูกกับคนที่เข้าระบบ · ส่งได้เฉพาะรายการของคนนี้
      setOutboxOwner(data.user.id, data.org.id);
      setMe(data);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [pathname, router]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  // ล็อกจอ = ปิด session นี้ทันที (ทำใน LockScreen) ปลดล็อกต้องใส่รหัสใหม่ เพราะเครื่องหน้าร้านใช้ร่วมกันหลายคน
  useIdleLock(me?.settings.idleLockMinutes ?? 15, !!me && !locked, () => setLocked(true));

  if (!me) return <ShellSkeleton />;

  const nav = NAV.filter((n) => !n.roles || n.roles.includes(me.role));
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  async function logout() {
    const p = await pendingSummary();
    if (p.n > 0) return setConfirmOut(p);
    await signOut();
    router.replace('/login');
  }

  return (
    <MeContext.Provider value={{ me, reload, logout: () => void logout() }}>
      <header className={styles.top}>
        <div className={styles.brand}>
          <span className="sun" aria-hidden="true" />
          <span className={styles.orgName}>{me.org.name}</span>
        </div>
        <span className={styles.spacer} />
        <span className={styles.sync} role="status">
          <span className={styles.dot} data-online={online} />
          <span className={styles.syncText}>{online ? 'ออนไลน์' : 'ออฟไลน์'}</span>
        </span>
        <span className={styles.user}>
          <span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{initials(me.user.displayName)}</span>
          <span className={styles.userName}>{me.user.displayName} · {ROLE_LABEL[me.role]}</span>
        </span>
        <button type="button" className={styles.topBtn} onClick={() => setLocked(true)}>ล็อกจอ</button>
        <button type="button" className={styles.topBtn} onClick={logout}>ออก</button>
      </header>
      <div className={styles.body}>
        <nav ref={sideRef} className={styles.side} aria-label="เมนูหลัก">
          {nav.filter((n) => !n.section).map((n) => (
            <Link key={n.href} href={n.href} className={styles.navLink} aria-current={isActive(n.href) ? 'page' : undefined}>
              {n.icon}
              {n.label}
            </Link>
          ))}
          {nav.some((n) => n.section === 'admin') && <div className={styles.navSection}>ตั้งค่า</div>}
          {nav.filter((n) => n.section === 'admin').map((n) => (
            <Link key={n.href} href={n.href} className={styles.navLink} aria-current={isActive(n.href) ? 'page' : undefined}>
              {n.icon}
              {n.label}
            </Link>
          ))}
        </nav>
        <main className={styles.main}>
          <PageFrame path={pathname}>{children}</PageFrame>
        </main>
      </div>
      <nav ref={bottomRef} className={styles.bottom} aria-label="เมนูหลัก (มือถือ)">
        {nav.filter((n) => n.mobile).map((n) => (
          <Link key={n.href} href={n.href} className={styles.bottomLink} aria-current={isActive(n.href) ? 'page' : undefined}>
            <span className={styles.bottomIcon}>{n.icon}</span>
            {n.label}
          </Link>
        ))}
        <Link href="/more" className={styles.bottomLink} aria-current={isActive('/more') ? 'page' : undefined}>
          <span className={styles.bottomIcon}>{MENU_ICON}</span>
          เมนู
        </Link>
      </nav>
      {confirmOut && (
        <div className={styles.lock} role="dialog" aria-modal="true" aria-labelledby="out-title">
          <div className={`card ${styles.outBox}`}>
            <h2 id="out-title">ยังมีงานที่ยังไม่ได้ส่ง</h2>
            <p>
              ยังมี <b>{confirmOut.n} รายการ</b> ที่ยังไม่ได้ส่งขึ้นระบบ{confirmOut.text ? ` (${confirmOut.text})` : ''} ถ้าออกตอนนี้รายการจะหาย · ออกเลยไหม
            </p>
            <div className={styles.outActions}>
              <button type="button" className="btn" autoFocus onClick={() => setConfirmOut(null)}>
                รอให้ส่งก่อน
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={async () => {
                  setConfirmOut(null);
                  await signOut();
                  router.replace('/login');
                }}
              >
                ออกเลย ทิ้งรายการ
              </button>
            </div>
          </div>
        </div>
      )}
      {locked && <LockScreen me={me} onUnlocked={() => { setLocked(false); void reload(); }} />}
    </MeContext.Provider>
  );
}

function useIdleLock(minutes: number, enabled: boolean, onIdle: () => void) {
  const last = useRef(Date.now());
  const cb = useRef(onIdle);
  cb.current = onIdle;
  useEffect(() => {
    if (!enabled) return;
    // ช่วงที่ไม่ได้แตะนับต่อจากครั้งก่อน แม้ปิดแท็บ/รีโหลด (เปิดมาใหม่หลังเกินเวลา = ล็อกทันที)
    const saved = Number(readLocal(ACTIVITY_KEY) ?? '');
    last.current = Number.isFinite(saved) && saved > 0 ? saved : Date.now();
    if (Date.now() - last.current > minutes * 60_000) cb.current();
    let lastWrite = 0;
    const touch = () => {
      last.current = Date.now();
      if (last.current - lastWrite > 5_000) {
        lastWrite = last.current;
        writeLocal(ACTIVITY_KEY, String(last.current));
      }
    };
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const t = setInterval(() => {
      if (Date.now() - last.current > minutes * 60_000) cb.current();
    }, 15_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch));
      clearInterval(t);
    };
  }, [minutes, enabled]);
}

/** ล็อกจอ: ปลดด้วยรหัสของคนเดิม หรือเปลี่ยนผู้ใช้ (mock story 1.01) */
function LockScreen({ me, onUnlocked }: { me: Me; onUnlocked: () => void }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.post('/v1/auth/logout').catch(() => undefined);
  }, []);

  async function unlock(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post<LoginResponse>('/v1/auth/login', { identifier: me.user.username, password, orgId: me.org.id });
      if (data.status === 'ok') onUnlocked();
      else router.replace('/login');
    } catch (err) {
      setError(messageFor(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.lock} role="dialog" aria-modal="true" aria-labelledby="lock-title">
      <form className={`card ${styles.lockCard}`} onSubmit={unlock}>
        <span className="avatar" style={{ width: 56, height: 56, fontSize: 18 }}>{initials(me.user.displayName)}</span>
        <h2 id="lock-title">ล็อกอยู่ · {me.user.displayName}</h2>
        <p className="muted">ไม่ได้ใช้งานนาน ใส่รหัสผ่านเพื่อทำงานต่อ</p>
        <label className="field" style={{ width: '100%' }}>
          รหัสผ่าน
          <input className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="alert alert-danger" role="alert" style={{ width: '100%' }}>{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'กำลังตรวจสอบ…' : 'ปลดล็อก'}</button>
        <button type="button" className="btn btn-block" onClick={() => router.replace('/login')}>เปลี่ยนผู้ใช้</button>
      </form>
    </div>
  );
}

/**
 * กรอบหน้าเดียวกันทุกหน้า (กว้างสูงสุด 1280 จัดกลาง) + ท่าเปลี่ยนหน้า
 * key ตาม path: เปลี่ยนหน้า = เล่นท่าใหม่ · [data-entering] อยู่ช่วงสั้นๆ ให้แถวไล่กันเฉพาะตอนเปิดหน้า
 */
function PageFrame({ path, children }: { path: string; children: ReactNode }) {
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    setEntering(true);
    const t = setTimeout(() => setEntering(false), 1400);
    return () => clearTimeout(t);
  }, [path]);
  return (
    <div key={path} className="page-frame page-enter" data-entering={entering || undefined}>
      {children}
    </div>
  );
}

function ShellSkeleton() {
  return (
    <div className={styles.loading} style={{ alignItems: 'flex-start', padding: '72px 24px' }}>
      <PageSkeleton />
    </div>
  );
}
