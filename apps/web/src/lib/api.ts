import { enqueue, queueLabel, withPaymentClientIds } from './offline';

/** error จาก API อยู่ในรูป { error: 'code', ...ข้อมูลเพิ่ม } · หน้าเว็บแปลง code เป็นข้อความเอง (lib/messages) */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

type Json = Record<string, unknown> | unknown[];

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      // API ยอมรับคำขอที่เปลี่ยนข้อมูลเฉพาะ JSON หรือที่มี header นี้ (กัน CSRF)
      'x-requested-with': 'fetch',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** ใช้ส่งรายการที่ค้างในโหมดออฟไลน์ (lib/offline) · คืนสถานะ + code โดยไม่โยน error */
export async function sendQueued(path: string, body: unknown): Promise<{ status: number; code: string | null }> {
  const res = await send('POST', path, body);
  if (res.ok) return { status: res.status, code: null };
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, code: data.error ?? null };
}

/** ใครรับคืนสัญญานี้ (ใช้ตอนส่งรับคืนที่ค้างในเครื่องซ้ำ) · เน็ตหลุด = โยน error ให้ลองรอบหน้า */
export async function rentalReturnedBy(rentalId: string): Promise<string | null> {
  const res = await send('GET', `/v1/rentals/${rentalId}`);
  if (res.status >= 500) throw new Error('server_error');
  if (!res.ok) return null;
  const data = (await res.json()) as { returnedBy?: string | null };
  return data.returnedBy ?? null;
}

async function call<T>(method: string, path: string, body?: Json): Promise<{ status: number; data: T }> {
  const label = queueLabel(method, path);
  const payload = label ? (withPaymentClientIds(path, body) as Json | undefined) : body;
  let res: Response;
  try {
    res = await send(method, path, payload);
  } catch {
    // เน็ตหลุด: งานหลักหน้าร้าน (ปล่อยเช่า รับคืน รับเงิน) เก็บไว้ส่งทีหลัง
    if (label && typeof indexedDB !== 'undefined') {
      try {
        await enqueue(path, payload, label);
        throw new ApiError(0, 'queued_offline');
      } catch (e) {
        if (e instanceof ApiError) throw e;
      }
    }
    throw new ApiError(0, 'network_error');
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const { error, ...rest } = data as { error?: string };
    throw new ApiError(res.status, typeof error === 'string' ? error : `http_${res.status}`, rest);
  }
  return { status: res.status, data: data as T };
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: Json) => call<T>('POST', path, body),
  patch: <T>(path: string, body: Json) => call<T>('PATCH', path, body),
};

// ---------- เฟส 1 · เงินทุกช่องเป็นหน่วยย่อย (สตางค์) ----------

export interface AssetVariant {
  id: string;
  label: string;
  quantity: number;
  out: number;
  available: number;
}

export interface AssetType {
  id: string;
  name: string;
  /** ชื่อที่ลูกค้าเห็น (หน้าจอง หน้าเซ็นสัญญา) · null = ใช้ name */
  publicName: string | null;
  /** รูปหน้าปกของประเภท */
  coverMediaId?: string | null;
  tracking: 'unit' | 'quantity';
  codePrefix: string | null;
  pricePerDay: number;
  deposit: number | null;
  listedOnMarketplace: boolean;
  serviceIntervalKm: number | null;
  unitCount: number;
  variants: AssetVariant[];
}

export type AssetState = 'available' | 'rented' | 'overdue' | 'maintenance';

export interface Asset {
  id: string;
  code: string;
  model: string | null;
  plate: string | null;
  color: string | null;
  odometer: number | null;
  status: 'available' | 'maintenance' | 'retired';
  pricePerDay: number;
  assetTypeId: string;
  typeName: string;
  rentalId: string | null;
  dueAt: string | null;
  customerName: string | null;
  hotelRoom: string | null;
  state: AssetState;
  /** รูปหน้าปก (ของคันนี้ ถ้าไม่มีใช้ของประเภท) */
  coverMediaId?: string | null;
  ownCover?: boolean;
  /** รหัสใน QR ที่ติดรถ */
  qrToken?: string;
  notes?: string | null;
}

export interface CustomerSummary {
  id: string;
  fullName: string;
  nationality: string | null;
  phone: string | null;
  hotelRoom: string | null;
  checkoutDate: string | null;
  doNotRent: boolean;
  openBillId: string | null;
  balance: number;
}

export interface Customer {
  id: string;
  fullName: string;
  nationality: string | null;
  phone: string | null;
  email: string | null;
  hotelRoom: string | null;
  checkoutDate: string | null;
  notes: string | null;
  doNotRent: boolean;
  doNotRentReason: string | null;
  createdAt: string;
  rentals: Array<{ id: string; status: RentalStatus; startAt: string; dueAt: string; returnedAt: string | null }>;
  openBill: { id: string; balance: number } | null;
}

export type RentalStatus = 'active' | 'returned' | 'cancelled';

export interface RentalItem {
  id: string;
  assetId: string | null;
  code: string | null;
  variantId: string | null;
  label: string;
  /** ชื่อที่ลูกค้าเห็น (ภาษาอังกฤษ ถ้าร้านตั้งไว้) */
  publicLabel?: string;
  /** รูปหน้าปกของคัน/ประเภท */
  coverMediaId?: string | null;
  quantity: number;
  pricePerDay: number;
  releasedAt: string | null;
}

export type LineKind = 'rental' | 'extension' | 'late_fee' | 'fuel' | 'damage' | 'gear' | 'discount' | 'other';

export interface RentalSummary {
  id: string;
  status: RentalStatus;
  startAt: string;
  dueAt: string;
  returnedAt: string | null;
  customerId: string;
  customerName: string;
  hotelRoom: string | null;
  phone: string | null;
  overdue: boolean;
  items: RentalItem[];
}

export interface Rental {
  id: string;
  billId: string | null;
  status: RentalStatus;
  channel: string;
  paymentMode: 'at_checkout' | 'pay_now';
  startAt: string;
  dueAt: string;
  returnedAt: string | null;
  returnedBy?: string | null;
  notes: string | null;
  overdue: boolean;
  customer: { id: string; fullName: string; hotelRoom: string | null; phone: string | null; checkoutDate: string | null };
  items: RentalItem[];
  lines: Array<{ id: string; billId: string; kind: LineKind; description: string; amount: number; reason: string | null; createdAt: string }>;
  total: number;
}

export interface ReturnPreview {
  lateMinutes: number;
  suggestedLateFee: number;
}

export interface BillSummary {
  id: string;
  status: 'open' | 'paid' | 'void';
  receiptNo: string | null;
  paidAt: string | null;
  createdAt: string;
  customerId: string;
  customerName: string;
  hotelRoom: string | null;
  checkoutDate: string | null;
  total: number;
  balance: number;
}

export type PaymentMethod = 'cash' | 'promptpay' | 'transfer' | 'card';

export interface Bill {
  id: string;
  status: 'open' | 'paid' | 'void';
  receiptNo: string | null;
  paidAt: string | null;
  voidReason: string | null;
  customer: { id: string; fullName: string; hotelRoom: string | null; phone: string | null; checkoutDate: string | null };
  lines: Array<{ id: string; rentalId: string | null; kind: LineKind; description: string; amount: number; reason: string | null; createdAt: string; by: string }>;
  payments: Array<{ id: string; method: PaymentMethod; amount: number; createdAt: string; by: string }>;
  total: number;
  paid: number;
  balance: number;
  /** ลูกค้าจ่ายเกิน (ยกเลิกสัญญาหลังจ่ายแล้ว) · ร้านต้องคืนเงินเท่านี้ */
  refundDue?: number;
}

export interface Today {
  date: string;
  overdue: Array<{ id: string; dueAt: string; customerId: string; customerName: string; hotelRoom: string | null; phone: string | null; items: string[] }>;
  dueToday: Array<{ id: string; dueAt: string; customerId: string; customerName: string; hotelRoom: string | null; phone: string | null; items: string[] }>;
  unpaidCheckouts: Array<{ billId: string; customerId: string; customerName: string; hotelRoom: string | null; balance: number }>;
  activeCount: number;
  moneyToday: Array<{ method: PaymentMethod; total: number }>;
}

// ---------- รูปข้อมูลจาก API ----------

export type Role = 'owner' | 'manager' | 'staff';

export type LoginResponse =
  | { status: 'ok'; orgId: string; userId: string; role: Role }
  | { status: 'choose_org'; orgs: Array<{ orgId: string; name: string; role: Role }> }
  | { status: 'device_pending'; deviceId: string; approvalCode: string; expiresInSeconds: number }
  | { status: 'totp_required'; expiresInSeconds: number }
  | { status: 'expired' };

export interface Me {
  user: { id: string; username: string; displayName: string; phone: string | null };
  org: { id: string; name: string; slug: string; timezone: string; currency: string; locale: string };
  role: Role;
  deviceId: string | null;
  /** อยู่ในโหมดลูกค้า (ยื่นเครื่องให้เซ็นสัญญานี้) */
  customerModeRentalId?: string | null;
  settings: { idleLockMinutes: number; staffDiscountCap: number; maxRentalDays: number | null; docRetentionDays: number };
}

export interface Member {
  userId: string;
  username: string;
  displayName: string;
  role: Role;
  status: 'active' | 'closed';
  closedAt: string | null;
}

export interface PendingInvitation {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  kind: 'invite' | 'reset';
  expiresAt: string;
}

export interface Device {
  id: string;
  name: string;
  status: 'pending' | 'approved' | 'revoked';
  requestedBy: string;
  createdAt: string;
  approvedAt: string | null;
  lastSeenAt: string | null;
}

export interface InvitationInfo {
  kind: 'invite' | 'reset';
  orgName: string;
  username: string;
  displayName: string;
  role: Role;
  expiresAt: string;
}
