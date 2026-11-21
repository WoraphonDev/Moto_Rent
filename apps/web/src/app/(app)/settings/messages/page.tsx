'use client';

import { useRef, useState } from 'react';
import { useMe } from '@/components/shell';
import { Skeleton, Tabs } from '@/components/motion';
import { Notice, PageHeader, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import type { MessageTemplate, TemplateKey } from '@/lib/api-p3';
import { messageFor } from '@/lib/messages';
import styles from './messages.module.css';

const LABEL: Record<TemplateKey, { title: string; when: string }> = {
  booking_confirmed: { title: 'ยืนยันการจอง', when: 'ส่งหลังกดยืนยันคำขอจอง' },
  booking_rejected: { title: 'ปฏิเสธการจอง', when: 'ส่งหลังปฏิเสธคำขอ' },
  return_reminder: { title: 'เตือนก่อนคืนรถ', when: 'ส่งก่อนครบกำหนดคืน ~2 ชม.' },
  receipt: { title: 'ใบเสร็จ', when: 'ส่งหลังรับเงินครบ' },
  thank_you: { title: 'ขอบคุณ + ขอรีวิว', when: 'ส่งหลังคืนรถ' },
};

/** ตัวอย่างค่าที่ใช้แสดงในกล่องข้อความ */
function sample(shop: string): Record<string, string> {
  return { name: 'Anna Schmidt', code: 'KR-7Q4M', vehicle: 'Honda Click 125 (C-05)', pickup: 'Sat 22 Nov, 10:00', return_time: 'Wed 26 Nov, 10:00', total: 'THB 1,000', shop };
}

/** ข้อความ WhatsApp (mock 3.W3) · ส่งแบบกดเอง (ฟรี) */
export default function MessagesSettingsPage() {
  const { me } = useMe();
  const canEdit = me.role !== 'staff';
  const list = useLoad(() => api.get<MessageTemplate[]>('/v1/message-templates').then((r) => r.data));
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);
  // แก้ทีละข้อความ (เดิมเรียง 5 การ์ดต่อกันยาว) · แท็บเลือกข้อความ
  const [selected, setSelected] = useState<TemplateKey>('booking_confirmed');
  const current = list.data?.find((t) => t.key === selected) ?? list.data?.[0];

  return (
    <div className={styles.page}>
      <PageHeader kicker="ตั้งค่า · ภาษาอังกฤษสำหรับลูกค้าต่างชาติ" title="ข้อความ WhatsApp" />
      <div className="alert alert-warn">
        ตอนนี้ส่งแบบ “กดส่งเอง”: ระบบเติมข้อความให้แล้วเปิด WhatsApp บนเครื่อง · ฟรี · ถ้าต้องการให้ระบบส่งอัตโนมัติ ต้องใช้ WhatsApp Business API ซึ่งมีค่าใช้จ่ายต่อข้อความ (ทำภายหลังได้)
      </div>
      <Notice notice={notice} />
      {list.error && <Notice notice={{ kind: 'danger', text: list.error }} />}
      {!list.data && !list.error && <Skeleton h={360} />}
      {list.data && list.data.length > 0 && (
        <div className={styles.list}>
          <Tabs<TemplateKey>
            label="เลือกข้อความ"
            value={current?.key ?? selected}
            onChange={setSelected}
            tabs={list.data.map((t) => ({ value: t.key, label: LABEL[t.key].title }))}
          />
          {current && (
            <div className="motion-swap" key={current.key}>
              <TemplateCard
                t={current}
                shop={me.org.name}
                canEdit={canEdit}
                onSaved={(text) => {
                  setNotice({ kind: 'ok', text });
                  void list.reload();
                }}
                onError={(text) => setNotice({ kind: 'danger', text })}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TemplateCard({ t, shop, canEdit, onSaved, onError }: { t: MessageTemplate; shop: string; canEdit: boolean; onSaved: (s: string) => void; onError: (s: string) => void }) {
  const [body, setBody] = useState(t.body);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const vars = sample(shop);
  const preview = body.replace(/\{(name|code|vehicle|pickup|return_time|total|shop)\}/g, (_, k: string) => vars[k] ?? '');

  function insert(v: string) {
    const el = area.current;
    if (!el) return setBody((b) => b + v);
    const s = el.selectionStart ?? body.length;
    const e = el.selectionEnd ?? body.length;
    const next = body.slice(0, s) + v + body.slice(e);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + v.length, s + v.length);
    });
  }

  async function save(value: string) {
    setBusy(true);
    try {
      await api.patch(`/v1/message-templates/${t.key}`, { body: value });
      onSaved(`บันทึก “${LABEL[t.key].title}” แล้ว`);
    } catch (e) {
      onError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`card ${styles.card}`} aria-labelledby={`t-${t.key}`}>
      <div className={styles.head}>
        <div>
          <h2 id={`t-${t.key}`}>{LABEL[t.key].title}</h2>
          <span className="muted" style={{ fontSize: 13 }}>{LABEL[t.key].when}</span>
        </div>
        <span className={`badge ${t.isDefault ? 'badge-neutral' : 'badge-info'}`}>{t.isDefault ? 'ค่าเริ่มต้น' : 'แก้แล้ว'}</span>
      </div>
      <div className={styles.cols}>
        <div className={styles.editor}>
          <label className="field">
            ข้อความ
            <textarea ref={area} className={`input ${styles.textarea}`} rows={6} maxLength={1000} value={body} readOnly={!canEdit} onChange={(e) => setBody(e.target.value)} />
          </label>
          {canEdit && (
            <>
              <div className={styles.chips} role="group" aria-label="ใส่ตัวแปร">
                {t.variables.map((v) => (
                  <button key={v} type="button" className="btn btn-sm" onClick={() => insert(v)}>
                    {v}
                  </button>
                ))}
              </div>
              <div className={styles.actions}>
                <button type="button" className="btn btn-primary" disabled={busy || body.trim().length < 5 || body === t.body} onClick={() => save(body)}>
                  บันทึก
                </button>
                {!t.isDefault && (
                  <button type="button" className="btn" disabled={busy} onClick={() => { setBody(t.defaultBody); void save(t.defaultBody); }}>
                    ใช้ข้อความเริ่มต้น
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <div className={styles.preview} aria-label="ตัวอย่างข้อความที่ลูกค้าเห็น">
          <span className="muted" style={{ fontSize: 12 }}>ตัวอย่างที่ลูกค้าเห็น</span>
          <div className={styles.bubble}>{preview}</div>
        </div>
      </div>
    </section>
  );
}
