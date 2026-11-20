/**
 * กล่องรอส่ง (outbox) ตอนเน็ตหลุด · เก็บใน IndexedDB ของเครื่อง แล้วส่งเองเมื่อเน็ตกลับมา
 * ส่งซ้ำได้ปลอดภัยเพราะทุกคำขอมี id จากเครื่อง:
 * - ปล่อยเช่า: id ของสัญญา (ส่งซ้ำได้สัญญาเดิม)
 * - รับคืน: ส่งซ้ำแล้วได้ 409 rental_closed = เคยสำเร็จแล้ว (ถ้าคนรับคืนคือคนเดียวกับที่กด)
 * แต่ละรายการผูกกับคนที่กด + ร้าน · ส่งเฉพาะตอนคนนั้นเข้าระบบอยู่
 * - รับเงิน: clientId ต่อรายการ (ส่งซ้ำแล้วไม่รับเงินซ้ำ)
 */

const DB_NAME = 'rental-outbox';
const STORE = 'requests';
export const OUTBOX_EVENT = 'outbox-change';

export interface QueuedRequest {
  id: string;
  path: string;
  body: unknown;
  label: string;
  createdAt: number;
  attempts: number;
  /** ส่งแล้วถูกปฏิเสธ (ไม่ใช่เน็ตหลุด) · หยุดส่งซ้ำ รอพนักงานดู */
  failed?: { status: number; code: string };
  /** คนที่กด + ร้าน · ส่งในนามคนนั้นเท่านั้น (เครื่องใช้ร่วมกันหลายคน/หลายร้าน) */
  userId?: string | null;
  orgId?: string | null;
}

let owner: { userId: string; orgId: string } | null = null;

/** ตั้งจากหน้าหลักหลังรู้ว่าใครเข้าระบบ · null = ออกจากระบบ */
export function setOutboxOwner(userId: string | null, orgId: string | null): void {
  owner = userId && orgId ? { userId, orgId } : null;
  changed();
}

export function outboxOwner() {
  return owner;
}

/** รายการนี้เป็นของคนที่เข้าระบบอยู่ตอนนี้หรือไม่ */
export function isMine(item: QueuedRequest): boolean {
  return !!owner && item.userId === owner.userId && item.orgId === owner.orgId;
}

const QUEUEABLE: Array<{ re: RegExp; label: string }> = [
  { re: /^\/v1\/rentals$/, label: 'ปล่อยเช่า' },
  { re: /^\/v1\/rentals\/[0-9a-f-]{36}\/return$/i, label: 'รับคืน' },
  { re: /^\/v1\/bills\/[0-9a-f-]{36}\/payments$/i, label: 'รับเงิน' },
];

export function queueLabel(method: string, path: string): string | null {
  if (method !== 'POST') return null;
  return QUEUEABLE.find((q) => q.re.test(path))?.label ?? null;
}

/** รับเงิน: ใส่ clientId ทุกรายการก่อนส่งครั้งแรก · ถ้าคำตอบหายระหว่างทาง ส่งซ้ำจะไม่รับเงินซ้ำ */
export function withPaymentClientIds(path: string, body: unknown): unknown {
  if (!/\/payments$/.test(path) || !body || typeof body !== 'object') return body;
  const b = body as { payments?: Array<Record<string, unknown>> };
  if (!Array.isArray(b.payments)) return body;
  return { ...b, payments: b.payments.map((p) => (p.clientId ? p : { ...p, clientId: crypto.randomUUID() })) };
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

function changed() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OUTBOX_EVENT));
}

export async function enqueue(path: string, body: unknown, label: string): Promise<void> {
  // ไม่รู้ว่าใครกด = ไม่เก็บ (ส่งทีหลังแล้วจะไปอยู่ในชื่อคนอื่น)
  if (!owner) throw new Error('outbox_no_owner');
  const item: QueuedRequest = { id: crypto.randomUUID(), path, body, label, createdAt: Date.now(), attempts: 0, userId: owner.userId, orgId: owner.orgId };
  await tx('readwrite', (s) => s.put(item));
  changed();
}

export async function listQueued(): Promise<QueuedRequest[]> {
  try {
    const all = await tx<QueuedRequest[]>('readonly', (s) => s.getAll() as IDBRequest<QueuedRequest[]>);
    return all.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

export async function removeQueued(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
  changed();
}

/** ล้างกล่องรอส่งทั้งหมดของเครื่อง (ออกจากระบบ) */
export async function clearOutbox(): Promise<void> {
  try {
    await tx('readwrite', (s) => s.clear());
  } catch {
    /* ไม่มี IndexedDB */
  }
  changed();
}

/** จำนวนที่ยังรอส่ง (ไม่นับที่ส่งไม่สำเร็จ) · ใช้เตือนก่อนออกจากระบบ */
export async function pendingCount(): Promise<number> {
  return (await listQueued()).filter((i) => !i.failed).length;
}

export type Sender = (path: string, body: unknown) => Promise<{ status: number; code: string | null }>;
/** อ่านสัญญาว่าใครรับคืน (ใช้ตรวจตอนส่งรับคืนซ้ำแล้วได้ rental_closed) */
export type ReturnedByLookup = (rentalId: string) => Promise<string | null | undefined>;

/** ส่งรับคืนซ้ำแล้วได้ rental_closed: นับว่าสำเร็จเฉพาะเมื่อคนรับคืนในระบบคือคนที่กดในเครื่องนี้ */
const RETURN_TAKEN_BY_OTHER = 'return_taken_by_other';

let flushing = false;

/**
 * ส่งรายการที่ค้างตามลำดับเวลา · เน็ตยังหลุดหรือเซิร์ฟเวอร์ล่ม = หยุดแล้วลองใหม่รอบหน้า
 * ถูกปฏิเสธ (4xx) = เก็บไว้เป็น "ส่งไม่สำเร็จ" ให้พนักงานดู ไม่ส่งซ้ำวนไปเรื่อยๆ
 */
export async function flush(send: Sender, returnedBy?: ReturnedByLookup): Promise<void> {
  if (flushing || typeof navigator === 'undefined' || !navigator.onLine || !owner) return;
  flushing = true;
  try {
    for (const item of await listQueued()) {
      // ส่งเฉพาะของคนที่เข้าระบบอยู่ · ของคนอื่นรอเจ้าของเข้าระบบอีกครั้ง
      if (item.failed || !isMine(item)) continue;
      let result: { status: number; code: string | null };
      try {
        result = await send(item.path, item.body);
      } catch {
        break;
      }
      let done = result.status >= 200 && result.status < 300;
      if (result.status === 409 && result.code === 'rental_closed' && item.path.endsWith('/return')) {
        // เคยส่งสำเร็จแล้ว (คำตอบหายระหว่างทาง) หรือมีคนอื่นรับคืนไปก่อน
        const rentalId = item.path.split('/')[3] ?? '';
        let by: string | null | undefined;
        try {
          by = returnedBy ? await returnedBy(rentalId) : undefined;
        } catch {
          break;
        }
        if (by && by === item.userId) done = true;
        else result = { status: 409, code: RETURN_TAKEN_BY_OTHER };
      }
      if (done) {
        await removeQueued(item.id);
      } else if (result.status === 0 || result.status >= 500) {
        break;
      } else {
        await tx('readwrite', (s) => s.put({ ...item, attempts: item.attempts + 1, failed: { status: result.status, code: result.code ?? `http_${result.status}` } }));
        changed();
      }
    }
  } finally {
    flushing = false;
  }
}
