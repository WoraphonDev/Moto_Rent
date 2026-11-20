'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { initials, useMe } from '@/components/shell';
import { api, type Device, type Member, type PendingInvitation } from '@/lib/api';
import { dateTimeOf, messageFor, ROLE_LABEL } from '@/lib/messages';
import styles from './staff.module.css';

interface Link {
  title: string;
  url: string;
  phone?: string;
  expiresAt: string;
}

/** พนักงานและเครื่อง (mock 2.05 / 2.W6) */
export default function StaffPage() {
  const { me } = useMe();
  const isOwner = me.role === 'owner';
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<PendingInvitation[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [link, setLink] = useState<Link | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, d] = await Promise.all([
        api.get<{ members: Member[]; pendingInvitations: PendingInvitation[] }>('/v1/members'),
        api.get<Device[]>('/v1/devices'),
      ]);
      setMembers(m.data.members);
      setInvites(m.data.pendingInvitations);
      setDevices(d.data);
    } catch (e) {
      setNotice({ kind: 'danger', text: messageFor(e) });
    }
  }, []);

  useEffect(() => {
    void load();
    // เครื่องที่ขออนุมัติเข้ามาใหม่จะโผล่เองโดยไม่ต้องรีเฟรช
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function run(action: () => Promise<unknown>, ok: string) {
    setNotice(null);
    try {
      await action();
      setNotice({ kind: 'ok', text: ok });
      await load();
    } catch (e) {
      setNotice({ kind: 'danger', text: messageFor(e) });
    }
  }

  const pending = devices.filter((d) => d.status === 'pending');
  const others = devices.filter((d) => d.status !== 'pending');
  const active = members.filter((m) => m.status === 'active').length;

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <p className="muted">ตั้งค่า · {isOwner ? 'เจ้าของเท่านั้นที่แก้ได้' : 'ดูได้อย่างเดียว'}</p>
          <h1>พนักงานและเครื่อง</h1>
        </div>
        <span className="badge badge-neutral">ใช้งาน {active} · ไม่จำกัดจำนวน</span>
      </div>

      {notice && (
        <div className={`alert alert-${notice.kind}`} role={notice.kind === 'danger' ? 'alert' : 'status'}>
          {notice.text}
        </div>
      )}

      {pending.length > 0 && (
        <section className="now" aria-label="เครื่องรออนุมัติ">
          <span className="now-label">ตอนนี้ · เครื่องรออนุมัติ {pending.length}</span>
          {pending.map((d) => (
            <ApproveDevice
              key={d.id}
              device={d}
              canApprove={isOwner}
              onApprove={(code) => run(() => api.post(`/v1/devices/${d.id}/approve`, { code }), `อนุมัติ ${d.name} แล้ว`)}
            />
          ))}
        </section>
      )}

      <div className={styles.grid}>
        <section className="card" style={{ minWidth: 0 }}>
          <div className="card-head">
            <h2>บัญชีพนักงาน</h2>
          </div>
          <div className="scroll-x">
            <table className="table table-stack">
              <thead>
                <tr>
                  <th scope="col">ชื่อ</th>
                  <th scope="col">ชื่อผู้ใช้</th>
                  <th scope="col">สิทธิ์</th>
                  <th scope="col">สถานะ</th>
                  {isOwner && <th scope="col"><span className="sr-only">จัดการ</span></th>}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId} className={m.status === 'closed' ? styles.closed : undefined}>
                    <td>
                      <span className={styles.person}>
                        <span className="avatar">{initials(m.displayName)}</span>
                        <b>{m.displayName}</b>
                      </span>
                    </td>
                    <td className="muted" data-label="ชื่อผู้ใช้">{m.username}</td>
                    <td data-label="สิทธิ์">
                      <span className={m.role === 'owner' ? 'badge badge-owner' : 'badge badge-neutral'}>{ROLE_LABEL[m.role]}</span>
                    </td>
                    <td data-label="สถานะ">
                      {m.status === 'active' ? (
                        <span className="badge badge-ok">ใช้งาน</span>
                      ) : (
                        <span className="badge badge-neutral">ปิดแล้ว {m.closedAt ? dateTimeOf(m.closedAt) : ''}</span>
                      )}
                    </td>
                    {isOwner && (
                      <td>
                        {m.status === 'active' && m.userId !== me.user.id && (
                          <span className={styles.actions}>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() =>
                                run(async () => {
                                  const { data } = await api.post<{ url: string; expiresAt: string }>(`/v1/members/${m.userId}/reset-link`);
                                  setLink({ title: `ลิงก์ตั้งรหัสใหม่ของ ${m.displayName}`, url: data.url, expiresAt: data.expiresAt });
                                }, 'สร้างลิงก์ตั้งรหัสใหม่แล้ว')
                              }
                            >
                              ลิงก์ตั้งรหัสใหม่
                            </button>
                            <ConfirmButton
                              label="ออกจากทุกเครื่อง"
                              onConfirm={() => run(() => api.post(`/v1/members/${m.userId}/sign-out-everywhere`), `${m.displayName} ออกจากระบบทุกเครื่องแล้ว`)}
                            />
                            <ConfirmButton
                              label="ปิดบัญชี"
                              danger
                              onConfirm={() => run(() => api.post(`/v1/members/${m.userId}/close`), `ปิดบัญชี ${m.displayName} แล้ว · ประวัติงานยังอยู่ครบ`)}
                            />
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <span className={styles.person}>
                        <span className="avatar" style={{ background: 'var(--info-soft)', color: 'var(--info-text)' }}>{initials(i.displayName)}</span>
                        <b>{i.displayName}</b>
                      </span>
                    </td>
                    <td className="muted" data-label="ชื่อผู้ใช้">{i.username}</td>
                    <td data-label="สิทธิ์">
                      <span className="badge badge-neutral">{ROLE_LABEL[i.role]}</span>
                    </td>
                    <td data-label="สถานะ">
                      <span className="badge badge-info">{i.kind === 'reset' ? 'รอตั้งรหัสใหม่' : 'รอตั้งรหัส'} · ถึง {dateTimeOf(i.expiresAt)}</span>
                    </td>
                    {isOwner && (
                      <td>
                        <ConfirmButton label="ยกเลิกลิงก์" danger onConfirm={() => run(() => api.post(`/v1/invitations/${i.id}/revoke`), 'ยกเลิกลิงก์แล้ว')} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: 12, padding: '10px 16px' }}>
            ลบบัญชีไม่ได้ ทำได้แค่ปิด เพื่อให้บิลและประวัติเดิมยังบอกได้ว่าใครทำ
          </p>
        </section>

        <aside className={styles.aside}>
          {link && <LinkCard link={link} onClose={() => setLink(null)} />}
          {isOwner && (
            <InviteForm
              onCreated={(l) => {
                setLink(l);
                void load();
              }}
            />
          )}
        </aside>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>เครื่องที่อนุญาต</h2>
          <span className="muted" style={{ fontSize: 13 }}>เข้าระบบได้เฉพาะเครื่องในรายการนี้</span>
        </div>
        <div className="scroll-x">
          <table className="table table-stack">
            <thead>
              <tr>
                <th scope="col">เครื่อง</th>
                <th scope="col">ขอโดย</th>
                <th scope="col">อนุมัติเมื่อ</th>
                <th scope="col">สถานะ</th>
                {isOwner && <th scope="col"><span className="sr-only">จัดการ</span></th>}
              </tr>
            </thead>
            <tbody>
              {others.map((d) => (
                <tr key={d.id} className={d.status === 'revoked' ? styles.closed : undefined}>
                  <td>
                    <b>{d.name}</b>
                    {d.id === me.deviceId && <span className="badge badge-info" style={{ marginLeft: 8 }}>เครื่องนี้</span>}
                  </td>
                  <td data-label="ขอโดย">{d.requestedBy}</td>
                  <td data-label="อนุมัติเมื่อ">{d.approvedAt ? dateTimeOf(d.approvedAt) : '—'}</td>
                  <td data-label="สถานะ">{d.status === 'approved' ? <span className="badge badge-ok">อนุญาต</span> : <span className="badge badge-danger">ตัดสิทธิ์แล้ว</span>}</td>
                  {isOwner && (
                    <td>
                      {d.status === 'approved' && d.id !== me.deviceId && (
                        <ConfirmButton
                          label="ตัดสิทธิ์"
                          danger
                          onConfirm={() => run(() => api.post(`/v1/devices/${d.id}/revoke`), `ตัดสิทธิ์ ${d.name} แล้ว · เครื่องนั้นออกจากระบบทันที`)}
                        />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ApproveDevice({ device, canApprove, onApprove }: { device: Device; canApprove: boolean; onApprove: (code: string) => Promise<void> }) {
  const [code, setCode] = useState('');
  return (
    <form
      className={styles.approve}
      onSubmit={(e) => {
        e.preventDefault();
        void onApprove(code).then(() => setCode(''));
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h2 style={{ fontSize: 18 }}>{device.name}</h2>
        <span className="now-sub">ขอโดย {device.requestedBy} · {dateTimeOf(device.createdAt)}</span>
      </div>
      {canApprove ? (
        <span className={styles.approveRow}>
          <label className="sr-only" htmlFor={`code-${device.id}`}>รหัสเครื่อง 4 ตัวที่แสดงบน {device.name}</label>
          <input
            id={`code-${device.id}`}
            className={`input ${styles.codeInput}`}
            placeholder="รหัส 4 ตัว"
            maxLength={4}
            autoCapitalize="characters"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button className="btn" disabled={code.length !== 4} style={{ background: 'var(--bg)', color: 'var(--primary)', borderColor: 'var(--bg)' }}>
            อนุมัติ
          </button>
        </span>
      ) : (
        <span className="now-sub">รอเจ้าของร้านอนุมัติ</span>
      )}
    </form>
  );
}

function InviteForm({ onCreated }: { onCreated: (l: Link) => void }) {
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<'staff' | 'manager'>('staff');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const cleanPhone = phone.replace(/[\s-]/g, '');
      const { data } = await api.post<{ url: string; expiresAt: string }>('/v1/invitations', {
        displayName: displayName.trim(),
        username: username.trim(),
        role,
        ...(cleanPhone ? { phone: cleanPhone } : {}),
      });
      onCreated({ title: `ลิงก์เชิญ ${displayName.trim()}`, url: data.url, expiresAt: data.expiresAt, phone: cleanPhone || undefined });
      setDisplayName('');
      setUsername('');
      setPhone('');
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`card ${styles.invite}`} onSubmit={submit}>
      <h2>+ เพิ่มพนักงาน</h2>
      <div className={styles.twoCol}>
        <label className="field">
          ชื่อเล่น
          <input className="input" required maxLength={60} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label className="field">
          ชื่อผู้ใช้
          <input
            className="input"
            required
            autoCapitalize="none"
            pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{2,31}"
            title="ภาษาอังกฤษหรือตัวเลข 3–32 ตัว ใช้ . _ - ได้"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
      </div>
      <label className="field">
        WhatsApp / เบอร์โทร <span className="muted" style={{ fontWeight: 400 }}>(ไม่บังคับ)</span>
        <input className="input" inputMode="tel" placeholder="+66812345678" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </label>
      <fieldset className={styles.roles}>
        <legend className="sr-only">สิทธิ์</legend>
        {(['staff', 'manager'] as const).map((r) => (
          <label key={r} className={styles.roleOption} data-on={role === r}>
            <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} />
            {ROLE_LABEL[r]}
          </label>
        ))}
      </fieldset>
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'กำลังสร้าง…' : 'สร้างลิงก์เชิญ'}</button>
      <span className="muted" style={{ fontSize: 12 }}>ลิงก์ใช้ได้ครั้งเดียว หมดอายุ 24 ชม. · พนักงานตั้งรหัสเอง</span>
    </form>
  );
}

function LinkCard({ link, onClose }: { link: Link; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `${link.title}\nเปิดลิงก์นี้เพื่อตั้งรหัสผ่าน (ใช้ได้ครั้งเดียว หมดอายุ ${dateTimeOf(link.expiresAt)})\n${link.url}`;
  const wa = `https://wa.me/${(link.phone ?? '').replace(/^\+/, '')}?text=${encodeURIComponent(text)}`;
  return (
    <section className="card" style={{ borderColor: 'var(--primary)', boxShadow: '0 0 0 1px var(--primary)' }} aria-live="polite">
      <div className="card-head">
        <h2>{link.title}</h2>
        <button type="button" className="btn btn-sm" onClick={onClose}>ปิด</button>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <code className={styles.url}>{link.url}</code>
        <span className="muted" style={{ fontSize: 12 }}>ลิงก์นี้แสดงครั้งเดียว ปิดแล้วต้องสร้างใหม่</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a className="btn btn-primary" href={wa} target="_blank" rel="noreferrer">ส่งทาง WhatsApp</a>
          <button
            type="button"
            className="btn"
            onClick={() =>
              navigator.clipboard
                .writeText(link.url)
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }
          >
            {copied ? 'คัดลอกแล้ว' : 'คัดลอกลิงก์'}
          </button>
        </div>
      </div>
    </section>
  );
}

/** กดครั้งแรกถาม กดครั้งที่สองทำจริง · กันกดพลาดโดยไม่ต้องมีหน้าต่างเด้ง */
function ConfirmButton({ label, danger, onConfirm }: { label: string; danger?: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={`btn btn-sm${danger ? ' btn-danger' : ''}`}
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
