'use client';

import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/api';
import { messageFor } from '@/lib/messages';
import styles from './totp.module.css';

interface Status {
  enabled: boolean;
  backupLeft: number;
  required: boolean;
}

/**
 * งานสำคัญ (อนุมัติเครื่อง เชิญพนักงาน ลิงก์ตั้งรหัสใหม่) ถ้าเซิร์ฟเวอร์ตอบ totp_required
 * → เปิดกล่องใส่รหัส 6 หลัก แล้วทำรายการเดิมต่อให้เอง
 */
export function useTotpPrompt(): { guard: <T>(fn: () => Promise<T>) => Promise<T>; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const waiter = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const guard = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'totp_required') throw e;
      await new Promise<void>((resolve, reject) => {
        waiter.current = { resolve, reject };
        setOpen(true);
      });
      return fn();
    }
  }, []);

  const dialog = open ? (
    <CodeDialog
      title="ยืนยันก่อนทำรายการสำคัญ"
      hint="ใส่รหัส 6 หลักจากแอปยืนยันตัวตน · ใส่แล้ว 15 นาทีไม่ถามซ้ำ"
      submit={(body) => api.post('/v1/auth/2fa/verify', body)}
      onDone={() => {
        setOpen(false);
        waiter.current?.resolve();
      }}
      onCancel={() => {
        setOpen(false);
        waiter.current?.reject(new ApiError(403, 'totp_required'));
      }}
    />
  ) : null;

  return { guard, dialog };
}

/** กล่องใส่รหัส 6 หลัก / รหัสสำรอง */
function CodeDialog({
  title,
  hint,
  withPassword,
  danger,
  submitLabel = 'ยืนยัน',
  submit,
  onDone,
  onCancel,
}: {
  title: string;
  hint: string;
  withPassword?: boolean;
  danger?: boolean;
  submitLabel?: string;
  submit: (body: { code?: string; backupCode?: string; password?: string }) => Promise<unknown>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [useBackup, setUseBackup] = useState(false);
  const [value, setValue] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  async function go(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await submit({
        ...(withPassword ? { password } : {}),
        ...(useBackup ? { backupCode: value.trim() } : { code: value.replace(/\s/g, '') }),
      });
      onDone();
    } catch (err) {
      setError(messageFor(err));
      setValue('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.backdrop}>
      <form className={`card ${styles.dialog}`} role="dialog" aria-modal="true" aria-labelledby="totp-title" onSubmit={go}>
        <h2 id="totp-title">{title}</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          {hint}
        </p>
        {error && (
          <div className="alert alert-danger" role="alert">
            {error}
          </div>
        )}
        {withPassword && (
          <label className="field">
            รหัสผ่านของคุณ
            <input ref={first} className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        {useBackup ? (
          <label className="field">
            รหัสสำรอง
            <input className="input" placeholder="XXXX-XXXX" maxLength={12} required value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
        ) : (
          <label className="field">
            รหัส 6 หลักจากแอป
            <input
              ref={withPassword ? undefined : first}
              className={`input ${styles.otp}`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              required
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/[^0-9 ]/g, ''))}
            />
          </label>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setUseBackup((v) => !v);
            setValue('');
          }}
        >
          {useBackup ? 'ใช้รหัส 6 หลักแทน' : 'มือถือไม่อยู่? ใช้รหัสสำรอง'}
        </button>
        <div className={styles.actions}>
          <button type="button" className="btn" onClick={onCancel}>
            ยกเลิก
          </button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy}>
            {busy ? 'กำลังตรวจสอบ…' : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

type Phase = { kind: 'idle' } | { kind: 'setup'; secret: string; svg: string } | { kind: 'codes'; codes: string[] } | { kind: 'disable' };

/** การ์ดยืนยันตัวตน 2 ชั้น (mock 7.W1) */
export function TwoFactorCard({ guard }: { guard: <T>(fn: () => Promise<T>) => Promise<T> }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus((await api.get<Status>('/v1/auth/2fa')).data);
    } catch (e) {
      setError(messageFor(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function start() {
    setError(null);
    setBusy(true);
    try {
      const { data } = await api.post<{ secret: string; uri: string }>('/v1/auth/2fa/setup');
      const svg = await QRCode.toString(data.uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      setPhase({ kind: 'setup', secret: data.secret, svg });
      setCode('');
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  async function enable(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { data } = await api.post<{ backupCodes: string[] }>('/v1/auth/2fa/enable', { code: code.replace(/\s/g, '') });
      setSaved(false);
      setPhase({ kind: 'codes', codes: data.backupCodes });
      await load();
    } catch (err) {
      setError(messageFor(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    setError(null);
    try {
      const { data } = await guard(() => api.post<{ backupCodes: string[] }>('/v1/auth/2fa/backup-codes'));
      setSaved(false);
      setPhase({ kind: 'codes', codes: data.backupCodes });
      await load();
    } catch (e) {
      setError(messageFor(e));
    }
  }

  if (!status) return null;
  const setupActive = phase.kind === 'setup';
  const codesShown = phase.kind === 'codes';

  return (
    <section className={`card ${styles.card}`} aria-labelledby="tfa-title">
      <div className={styles.head}>
        <span className={styles.titleRow}>
          <h2 id="tfa-title">ยืนยันตัวตน 2 ชั้น · เจ้าของร้าน</h2>
          {status.enabled ? <span className="badge badge-ok">เปิดอยู่</span> : <span className="badge badge-warn">ยังไม่เปิด</span>}
        </span>
        {!status.enabled && <span className="muted" style={{ fontSize: 13 }}>ใช้เวลาประมาณ 2 นาที</span>}
      </div>

      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      {!status.enabled && !codesShown && (
        <div className="alert alert-warn" role="note">
          <span>
            <b>ทำไมต้องเปิด</b> ถ้ารหัสผ่านของเจ้าของร้านหลุด คนอื่นจะเข้าระบบจากเครื่องใหม่และเห็นข้อมูลลูกค้าทั้งหมดได้ · เปิดแล้วต้องมีรหัส 6 หลักจากมือถือของคุณด้วย ·
            ต้องเปิดก่อนจึงจะอนุมัติเครื่องหรือเชิญพนักงานได้
          </span>
        </div>
      )}

      {(setupActive || codesShown || !status.enabled) && (
        <div className={styles.steps}>
          <div className={styles.step}>
            <span className={styles.stepHead}>
              <span className={styles.sn} data-on={setupActive || !status.enabled}>1</span>สแกน QR ด้วยแอปยืนยันตัวตน
            </span>
            <p className="muted" style={{ fontSize: 13 }}>
              ใช้ Google Authenticator, Microsoft Authenticator หรือ 1Password ก็ได้ (ฟรี)
            </p>
            {phase.kind === 'setup' ? (
              <div className={styles.qrRow}>
                <div className={styles.qr} role="img" aria-label="QR สำหรับสแกนด้วยแอปยืนยันตัวตน" dangerouslySetInnerHTML={{ __html: phase.svg }} />
                <div style={{ minWidth: 0, fontSize: 13 }}>
                  <div className="muted">สแกนไม่ได้? พิมพ์รหัสนี้แทน</div>
                  <code className={styles.secret}>{phase.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
                </div>
              </div>
            ) : (
              !status.enabled && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start()}>
                  {busy ? 'กำลังเตรียม…' : 'เริ่มตั้งค่า'}
                </button>
              )
            )}
          </div>

          <form className={styles.step} onSubmit={enable}>
            <span className={styles.stepHead}>
              <span className={styles.sn} data-on={setupActive}>2</span>ใส่รหัส 6 หลักที่แอปแสดง
            </span>
            <label className="field">
              รหัสจากแอป
              <input
                className={`input ${styles.otp}`}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                disabled={!setupActive}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ''))}
              />
              <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>รหัสเปลี่ยนทุก 30 วินาที</span>
            </label>
            <button className="btn btn-primary" disabled={!setupActive || busy || code.replace(/\s/g, '').length !== 6}>
              ยืนยันและเปิดใช้
            </button>
          </form>

          <div className={styles.step}>
            <span className={styles.stepHead}>
              <span className={styles.sn} data-on={codesShown}>3</span>เก็บรหัสสำรองไว้
            </span>
            <p className="muted" style={{ fontSize: 13 }}>
              ใช้แทนเมื่อมือถือหายหรือเปลี่ยนเครื่อง · ใช้ได้รหัสละ 1 ครั้ง · ระบบแสดงครั้งเดียว
            </p>
            {phase.kind === 'codes' && (
              <>
                <div className={styles.codes}>
                  {phase.codes.map((c) => (
                    <code key={c}>{c}</code>
                  ))}
                </div>
                <span className={styles.row}>
                  <button type="button" className="btn btn-sm" onClick={() => window.print()}>
                    พิมพ์
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(phase.codes.join('\n'))}>
                    คัดลอก
                  </button>
                </span>
                <label className="check">
                  <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
                  เก็บไว้ในที่ปลอดภัยแล้ว
                </label>
                <button type="button" className="btn btn-primary" disabled={!saved} onClick={() => setPhase({ kind: 'idle' })}>
                  เสร็จ
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {status.enabled && !codesShown && (
        <div className={styles.enabled}>
          <div>
            <b>เปิดแล้ว ระบบจะถามรหัส 6 หลักเมื่อ</b>
            <ul className={styles.list}>
              <li>
                เจ้าของเข้าระบบจาก <b>เครื่องใหม่</b> (เครื่องเดิมไม่ถาม)
              </li>
              <li>อนุมัติเครื่องใหม่ของพนักงาน</li>
              <li>เชิญพนักงาน หรือออกลิงก์ตั้งรหัสผ่านใหม่</li>
              <li>ปิดการยืนยัน 2 ชั้น (ต้องใส่ทั้งรหัสผ่านและรหัส 6 หลัก)</li>
            </ul>
            <p className="muted" style={{ fontSize: 13 }}>
              ใส่รหัสถูกแล้ว 15 นาทีไม่ถามซ้ำ · ผิด 5 ครั้ง พักไว้ 15 นาที · ทุกครั้งบันทึกลงประวัติการใช้งาน
            </p>
          </div>
          <div className={styles.side}>
            <span style={{ fontSize: 13 }}>รหัสสำรองเหลือ {status.backupLeft}</span>
            <span className={styles.row}>
              <button type="button" className="btn btn-sm" onClick={() => void regenerate()}>
                สร้างรหัสสำรองใหม่
              </button>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setPhase({ kind: 'disable' })}>
                ปิด / เปลี่ยนมือถือ
              </button>
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              เปลี่ยนมือถือ = ปิดแล้วตั้งใหม่ด้วยมือถือเครื่องใหม่
            </span>
          </div>
        </div>
      )}

      {phase.kind === 'disable' && (
        <CodeDialog
          title="ปิดยืนยันตัวตน 2 ชั้น"
          hint="ปิดแล้วอนุมัติเครื่องและเชิญพนักงานไม่ได้จนกว่าจะตั้งใหม่ · ต้องใส่รหัสผ่านและรหัส 6 หลัก"
          withPassword
          danger
          submitLabel="ปิดการยืนยัน 2 ชั้น"
          submit={(body) => api.post('/v1/auth/2fa/disable', body)}
          onDone={() => {
            setPhase({ kind: 'idle' });
            void load();
          }}
          onCancel={() => setPhase({ kind: 'idle' })}
        />
      )}
    </section>
  );
}
