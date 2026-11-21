'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type LoginResponse } from '@/lib/api';
import { messageFor, ROLE_LABEL } from '@/lib/messages';
import { readLocal, REMEMBERED_USERNAME, resetIdleLock, writeLocal } from '@/lib/storage';
import { safeNext } from '@/lib/safe-next';
import styles from './login.module.css';

type Step =
  | { kind: 'form' }
  | { kind: 'choose_org'; orgs: Extract<LoginResponse, { status: 'choose_org' }>['orgs'] }
  | { kind: 'pending'; approvalCode: string; expiresAt: number }
  | { kind: 'totp' };

const POLL_MS = 3000;

/** หน้าเข้าระบบ (mock 1.01 / 1.W0) · ไม่มีรายชื่อพนักงานให้เลือก */
export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = readLocal(REMEMBERED_USERNAME);
    if (saved) {
      setIdentifier(saved);
      passwordRef.current?.focus();
    }
  }, []);

  function done() {
    writeLocal(REMEMBERED_USERNAME, remember ? identifier.trim() : null);
    // ล็อกจอที่จำไว้จาก session ก่อน ไม่เกี่ยวกับการเข้าระบบครั้งนี้ (เดิมเข้าแล้วล็อกทันทีและหลุดอีกรอบ)
    resetIdleLock();
    router.replace(safeNext(new URLSearchParams(window.location.search).get('next')));
  }

  function handle(r: LoginResponse) {
    if (r.status === 'ok') return done();
    if (r.status === 'choose_org') return setStep({ kind: 'choose_org', orgs: r.orgs });
    if (r.status === 'device_pending') {
      return setStep({ kind: 'pending', approvalCode: r.approvalCode, expiresAt: Date.now() + r.expiresInSeconds * 1000 });
    }
    if (r.status === 'totp_required') return setStep({ kind: 'totp' });
    setStep({ kind: 'form' });
    setError('คำขอหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
  }

  async function submit(e: FormEvent, orgId?: string) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post<LoginResponse>('/v1/auth/login', {
        identifier: identifier.trim(),
        password,
        ...(orgId ? { orgId } : {}),
        ...(deviceName.trim() ? { deviceName: deviceName.trim() } : {}),
      });
      handle(data);
    } catch (err) {
      setStep({ kind: 'form' });
      setError(messageFor(err));
      if (err instanceof ApiError && err.code === 'invalid_credentials') setPassword('');
    } finally {
      setBusy(false);
    }
  }

  // รอเจ้าของอนุมัติ: ถามซ้ำทุก 3 วินาที อนุมัติแล้วเข้าระบบเอง
  useEffect(() => {
    if (step.kind !== 'pending') return;
    const t = setInterval(async () => {
      setNow(Date.now());
      try {
        const { data } = await api.get<LoginResponse>('/v1/auth/pending');
        if (data.status !== 'device_pending') handle(data);
      } catch (err) {
        setStep({ kind: 'form' });
        setError(messageFor(err));
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [step.kind]);

  return (
    <main className={styles.wrap}>
      <section className={styles.brand} aria-label="ร้านเช่า">
        <div className={styles.brandName}>
          <span className="sun" aria-hidden="true" />
          ระบบหลังร้าน
        </div>
        <div>
          <h2 className={styles.pitch}>บริหารร้านเช่า<br />ในข้อมูลชุดเดียวทุกเครื่อง</h2>
          <ul className={styles.points}>
            <li>ทุกคนเข้าด้วยบัญชีของตัวเอง ทุกการกระทำมีชื่อกำกับ</li>
            <li>เข้าได้เฉพาะเครื่องที่เจ้าของร้านอนุมัติ</li>
            <li>ไม่ได้แตะเครื่องนานจะล็อกหน้าจอเอง</li>
          </ul>
        </div>
      </section>

      <section className={styles.formSide}>
        <div className={styles.box}>
          {step.kind === 'pending' ? (
            <PendingDevice code={step.approvalCode} secondsLeft={Math.max(0, Math.round((step.expiresAt - now) / 1000))} onCancel={() => setStep({ kind: 'form' })} />
          ) : step.kind === 'totp' ? (
            <TotpStep
              username={identifier.trim()}
              onDone={handle}
              onBack={(msg) => {
                setStep({ kind: 'form' });
                setPassword('');
                setError(msg ?? null);
              }}
            />
          ) : (
            <>
              <div>
                <h1 className={styles.title}>เข้าสู่ระบบ</h1>
                <p className="muted">ใช้ชื่อผู้ใช้หรือเบอร์โทรที่เจ้าของร้านลงทะเบียนไว้</p>
              </div>

              {error && (
                <div className="alert alert-danger" role="alert">
                  {error}
                </div>
              )}

              {step.kind === 'choose_org' ? (
                <div className={styles.orgList} role="group" aria-label="เลือกร้าน">
                  <p className="muted">บัญชีนี้อยู่หลายร้าน เลือกร้านที่จะทำงาน</p>
                  {step.orgs.map((o) => (
                    <button key={o.orgId} type="button" className="btn btn-block" disabled={busy} onClick={(e) => submit(e, o.orgId)}>
                      <span style={{ flex: 1, textAlign: 'left' }}>{o.name}</span>
                      <span className="badge badge-neutral">{ROLE_LABEL[o.role]}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <form className={`card ${styles.form}`} onSubmit={(e) => submit(e)}>
                  <label className="field">
                    ชื่อผู้ใช้ หรือ เบอร์โทร
                    <input
                      className="input"
                      name="username"
                      autoComplete="username"
                      autoCapitalize="none"
                      required
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field-row">
                      รหัสผ่าน
                      <span className="muted" style={{ fontWeight: 400 }}>ลืมรหัส? ขอลิงก์ใหม่จากเจ้าของร้าน</span>
                    </span>
                    <span className={styles.pwWrap}>
                      <input
                        ref={passwordRef}
                        className="input"
                        name="password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        required
                        value={password}
                        aria-invalid={error ? true : undefined}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                      <button type="button" className={styles.pwToggle} onClick={() => setShowPassword((v) => !v)}>
                        {showPassword ? 'ซ่อน' : 'แสดง'}
                      </button>
                    </span>
                  </label>
                  <details className={styles.more}>
                    <summary>ตั้งชื่อเครื่องนี้ (ครั้งแรกที่ใช้เครื่องนี้)</summary>
                    <input
                      className="input"
                      placeholder="เช่น iPad หน้าร้าน, มือถือ Nok"
                      maxLength={60}
                      value={deviceName}
                      onChange={(e) => setDeviceName(e.target.value)}
                      aria-label="ชื่อเครื่อง"
                    />
                  </details>
                  <label className="check">
                    <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                    จำชื่อผู้ใช้ในเครื่องนี้ <span className="muted">(ไม่จำรหัสผ่าน)</span>
                  </label>
                  <button className="btn btn-primary btn-block" disabled={busy}>
                    {busy ? 'กำลังตรวจสอบ…' : 'เข้าสู่ระบบ'}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function PendingDevice({ code, secondsLeft, onCancel }: { code: string; secondsLeft: number; onCancel: () => void }) {
  const m = Math.floor(secondsLeft / 60);
  const s = String(secondsLeft % 60).padStart(2, '0');
  return (
    <>
      <div>
        <p className="muted">รหัสผ่านถูกต้อง · เครื่องนี้ยังไม่เคยใช้กับร้านนี้</p>
        <h1 className={styles.title}>รอเจ้าของร้านอนุมัติ</h1>
      </div>
      <section className="now" aria-live="polite">
        <span className="now-label">รหัสเครื่อง</span>
        <span className={styles.code}>{code}</span>
        <span className="now-sub">ให้เจ้าของร้านเปิดหน้า “พนักงานและเครื่อง” แล้วพิมพ์รหัสนี้เพื่ออนุมัติ · อนุมัติแล้วหน้านี้จะเข้าระบบให้เอง</span>
      </section>
      <div className="alert alert-warn" role="status">
        กำลังรอ · คำขอหมดอายุใน {m}:{s} นาที
      </div>
      <button type="button" className="btn btn-block" onClick={onCancel}>
        ยกเลิก
      </button>
    </>
  );
}

/** เจ้าของร้านเข้าจากเครื่องใหม่: ใส่รหัส 6 หลักจากแอป หรือรหัสสำรอง (mock 7.01) */
function TotpStep({ username, onDone, onBack }: { username: string; onDone: (r: LoginResponse) => void; onBack: (msg?: string) => void }) {
  const [useBackup, setUseBackup] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = useBackup ? { backupCode: value.trim() } : { code: value.replace(/\s/g, '') };
      const { data } = await api.post<LoginResponse>('/v1/auth/login/totp', body);
      onDone(data);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totp_expired') return onBack(messageFor(err));
      setError(messageFor(err));
      setValue('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div>
        <h1 className={styles.title}>ยืนยันว่าเป็นคุณ</h1>
        <p className="muted">เข้าระบบจากเครื่องใหม่ · {username}</p>
      </div>
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
      <form className={`card ${styles.form}`} onSubmit={submit}>
        {useBackup ? (
          <label className="field">
            รหัสสำรอง (ใช้ได้รหัสละครั้ง)
            <input className="input" autoCapitalize="characters" autoComplete="off" placeholder="XXXX-XXXX" maxLength={12} required value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
        ) : (
          <label className="field">
            เปิดแอปยืนยันตัวตนในมือถือของคุณ แล้วใส่รหัส 6 หลัก
            <input
              className={`input ${styles.otp}`}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              required
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/[^0-9 ]/g, ''))}
            />
          </label>
        )}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'กำลังตรวจสอบ…' : 'ยืนยัน'}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          onClick={() => {
            setUseBackup((v) => !v);
            setValue('');
            setError(null);
          }}
        >
          {useBackup ? 'ใช้รหัส 6 หลักจากแอปแทน' : 'มือถือไม่อยู่? ใช้รหัสสำรองแทน'}
        </button>
      </form>
      <div className="alert alert-ok" role="note">
        ยืนยันแล้วเครื่องนี้จะถูกจำไว้ ครั้งหน้าไม่ต้องใส่อีก
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        ใส่ผิด 5 ครั้ง ระบบพักไว้ 15 นาที และบันทึกในประวัติการใช้งาน
      </p>
      <button type="button" className="btn btn-block" onClick={() => onBack()}>
        กลับไปหน้าเข้าระบบ
      </button>
    </>
  );
}
