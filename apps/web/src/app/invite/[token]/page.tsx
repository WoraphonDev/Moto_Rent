'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, type InvitationInfo } from '@/lib/api';
import { dateTimeOf, messageFor, passwordChecks, ROLE_LABEL } from '@/lib/messages';
import { writeLocal, REMEMBERED_USERNAME } from '@/lib/storage';
import styles from './invite.module.css';

/** เปิดลิงก์เชิญ / ลิงก์ตั้งรหัสใหม่ (mock 1.01b) · ตั้งรหัสเองแล้วไปเข้าระบบ ซึ่งจะขออนุมัติเครื่อง */
export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api
      .get<InvitationInfo>(`/v1/invitations/${encodeURIComponent(token)}`)
      .then(({ data }) => setInfo(data))
      .catch((e) => setLoadError(messageFor(e)));
  }, [token]);

  const checks = useMemo(() => passwordChecks(password, confirm, [info?.username]), [password, confirm, info?.username]);
  const ready = checks.every((c) => c.ok);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || !info) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/invitations/${encodeURIComponent(token)}/accept`, { password });
      writeLocal(REMEMBERED_USERNAME, info.username);
      setDone(true);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <main className={styles.page}>
        <div className="alert alert-danger" role="alert">{loadError}</div>
        <Link className="btn" href="/login">ไปหน้าเข้าสู่ระบบ</Link>
      </main>
    );
  }
  if (!info) return <main className={styles.page}><p className="muted">กำลังเปิดลิงก์…</p></main>;

  const isReset = info.kind === 'reset';

  if (done) {
    return (
      <main className={styles.page}>
        <section className="now">
          <span className="now-label">ตั้งรหัสแล้ว</span>
          <h1 style={{ fontSize: 22 }}>ชื่อผู้ใช้ของคุณคือ {info.username}</h1>
          <span className="now-sub">ขั้นต่อไป: เข้าสู่ระบบบนเครื่องนี้ แล้วรอเจ้าของร้านอนุมัติเครื่อง</span>
        </section>
        <Link className="btn btn-primary btn-block" href="/login">เข้าสู่ระบบ</Link>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.top}>
        <span>{isReset ? 'ลิงก์ตั้งรหัสใหม่' : 'ลิงก์เชิญ'} จาก <b>{info.orgName}</b></span>
        <span className="badge badge-warn">หมดอายุ {dateTimeOf(info.expiresAt)}</span>
      </div>
      <div>
        <h1 className={styles.title}>{isReset ? `ตั้งรหัสใหม่ ${info.displayName}` : `ยินดีต้อนรับ ${info.displayName}`}</h1>
        <p className="muted">{isReset ? 'ตั้งรหัสแล้วทุกเครื่องที่เคยเข้าไว้จะออกจากระบบ' : 'ตั้งรหัสผ่านของคุณเอง เจ้าของร้านไม่เห็นรหัสนี้'}</p>
      </div>

      <form className={`card ${styles.form}`} onSubmit={submit}>
        <dl className={styles.facts}>
          <dt>ชื่อผู้ใช้</dt>
          <dd><b>{info.username}</b></dd>
          <dt>สิทธิ์</dt>
          <dd><span className="badge badge-info">{ROLE_LABEL[info.role]}</span></dd>
        </dl>
        <input type="text" name="username" autoComplete="username" value={info.username} readOnly hidden />
        <label className="field">
          รหัสผ่านใหม่
          <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label className="field">
          ใส่รหัสผ่านอีกครั้ง
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        <ul className={styles.checks} aria-label="เงื่อนไขรหัสผ่าน">
          {checks.map((c) => (
            <li key={c.label} data-ok={c.ok}>
              <span aria-hidden="true">{c.ok ? '✓' : '·'}</span> {c.label}
              <span className="sr-only">{c.ok ? 'ผ่าน' : 'ยังไม่ผ่าน'}</span>
            </li>
          ))}
        </ul>
        {error && <div className="alert alert-danger" role="alert">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={!ready || busy}>
          {busy ? 'กำลังบันทึก…' : 'บันทึกรหัสผ่าน'}
        </button>
      </form>
      <p className="muted" style={{ fontSize: 12, textAlign: 'center' }}>ลิงก์นี้ใช้ได้ครั้งเดียว · ไม่ได้ขอ? แจ้งเจ้าของร้าน</p>
    </main>
  );
}
