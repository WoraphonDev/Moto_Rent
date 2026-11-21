import { ApiError, type Role } from './api';
import { MESSAGES_P1 } from './messages-p1';
import { MESSAGES_P2 } from './messages-p2';
import { MESSAGES_P3 } from './messages-p3';

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  account_locked: 'ใส่รหัสผิดหลายครั้ง บัญชีถูกล็อกชั่วคราว',
  rate_limited: 'ลองบ่อยเกินไป กรุณารอสักครู่',
  device_revoked: 'เครื่องนี้ถูกตัดสิทธิ์ ติดต่อเจ้าของร้าน',
  no_active_membership: 'บัญชีนี้ไม่ได้อยู่ในร้านใดแล้ว ติดต่อเจ้าของร้าน',
  not_a_member: 'บัญชีนี้ไม่ได้อยู่ในร้านที่เลือก',
  invitation_invalid: 'ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว ขอลิงก์ใหม่จากเจ้าของร้าน',
  username_taken: 'ชื่อผู้ใช้นี้มีคนใช้แล้ว',
  phone_taken: 'เบอร์นี้ใช้กับบัญชีอื่นแล้ว',
  slug_taken: 'ชื่อร้านใน URL นี้มีคนใช้แล้ว',
  weak_password: 'รหัสผ่านเดาง่ายเกินไป',
  invalid_input: 'ข้อมูลไม่ครบหรือไม่ถูกรูปแบบ',
  approval_code_mismatch: 'รหัสเครื่องไม่ตรงกับที่แสดงบนเครื่องที่ขอ',
  device_not_pending: 'เครื่องนี้ไม่ได้รออนุมัติแล้ว',
  member_not_found: 'ไม่พบพนักงานคนนี้',
  cannot_close_self: 'ปิดบัญชีของตัวเองไม่ได้',
  forbidden: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้',
  unauthenticated: 'กรุณาเข้าสู่ระบบอีกครั้ง',
  network_error: 'เชื่อมต่อไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่',
  // ยืนยันตัวตน 2 ชั้น
  totp_invalid: 'รหัสไม่ถูกต้อง หรือใช้ไปแล้ว · รอรหัสใหม่ในแอปแล้วลองอีกครั้ง',
  totp_locked: 'ใส่รหัสผิดหลายครั้ง พักไว้ 15 นาที',
  totp_expired: 'หมดเวลาใส่รหัส กรุณาเข้าสู่ระบบอีกครั้ง',
  totp_required: 'ใส่รหัส 6 หลักจากแอปยืนยันตัวตนก่อนทำรายการนี้',
  totp_setup_required: 'เจ้าของร้านต้องเปิดยืนยันตัวตน 2 ชั้นก่อน (ตั้งค่า › พนักงานและเครื่อง) · ถ้าเข้าจากเครื่องใหม่ ให้เข้าจากเครื่องเดิมแล้วเปิดก่อน',
  totp_not_set: 'ยังไม่ได้ตั้งยืนยันตัวตน 2 ชั้น',
  totp_already_enabled: 'เปิดยืนยันตัวตน 2 ชั้นอยู่แล้ว · ถ้าจะเปลี่ยนมือถือ ให้ปิดก่อนแล้วตั้งใหม่',
  totp_code_required: 'ใส่รหัส 6 หลัก',
  // เฟส 1
  not_found: 'ไม่พบรายการนี้',
  asset_unavailable: 'ของชิ้นนี้ไม่ว่าง (ถูกเช่าอยู่หรือส่งซ่อม)',
  asset_code_taken: 'รหัสนี้มีอยู่แล้ว',
  variant_label_taken: 'มีไซส์นี้อยู่แล้ว',
  not_enough_stock: 'ของไม่พอ',
  too_many_days: 'เกินจำนวนวันเช่าสูงสุดของร้าน',
  customer_blocked: 'ลูกค้าคนนี้ติดธง “ไม่ให้เช่า”',
  customer_not_found: 'ไม่พบลูกค้า',
  rental_closed: 'สัญญานี้จบไปแล้ว',
  returned_before_start: 'เวลาคืนก่อนเวลาเริ่มเช่า',
  bill_closed: 'บิลนี้ปิดแล้ว แก้ไขไม่ได้',
  overpayment: 'รับเงินเกินยอดค้าง',
  discount_over_limit: 'ส่วนลดเกินเพดานของคุณ ต้องให้เจ้าของร้านทำ',
  owner_only: 'เฉพาะเจ้าของร้าน',
  forbidden_field: 'บัญชีนี้แก้ช่องนี้ไม่ได้',
  reason_required: 'ต้องใส่เหตุผล',
  code_prefix_required: 'ของรายชิ้นต้องมีรหัสนำหน้า เช่น C-',
  type_not_quantity: 'ประเภทนี้ไม่ได้นับจำนวน',
  type_not_unit: 'ประเภทนี้ไม่ได้เป็นรายชิ้น',
  ...MESSAGES_P1,
  ...MESSAGES_P2,
  ...MESSAGES_P3,
};

export function messageFor(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'account_locked' && typeof e.data.lockedUntil === 'string') {
      return `${MESSAGES.account_locked} ถึง ${timeOf(e.data.lockedUntil)} และแจ้งเจ้าของร้านแล้ว`;
    }
    if (e.code === 'not_enough_stock' && typeof e.data.available === 'number') {
      return `${String(e.data.label ?? 'ของ')} เหลือ ${e.data.available} ชิ้น`;
    }
    if (e.code === 'too_many_days' && typeof e.data.maxDays === 'number') return `เช่าได้นานสุด ${e.data.maxDays} วัน`;
    if (e.code === 'customer_blocked') return `${MESSAGES.customer_blocked}${e.data.reason ? `: ${String(e.data.reason)}` : ''}`;
    if (e.code === 'rate_limited' && typeof e.data.retryAfterSeconds === 'number') {
      return `${MESSAGES.rate_limited} (${Math.ceil(e.data.retryAfterSeconds / 60)} นาที)`;
    }
    return MESSAGES[e.code] ?? `เกิดข้อผิดพลาด (${e.code})`;
  }
  return 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง';
}

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

export function dateTimeOf(iso: string): string {
  return new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export const ROLE_LABEL: Record<Role, string> = { owner: 'เจ้าของ', manager: 'ผู้จัดการ', staff: 'พนักงาน' };

/** ตรวจรหัสผ่านฝั่งหน้าเว็บให้เห็นทันที (API ตรวจซ้ำเสมอ) */
export function passwordChecks(password: string, confirm: string, identity: Array<string | null | undefined>) {
  const p = password.toLowerCase();
  const containsIdentity = identity.some((i) => i && i.length >= 3 && p.includes(i.toLowerCase().replace(/[^a-z0-9]/g, '')));
  return [
    { label: 'อย่างน้อย 8 ตัว', ok: password.length >= 8 },
    { label: 'ไม่มีชื่อผู้ใช้หรือเบอร์โทรอยู่ในรหัส', ok: password.length > 0 && !containsIdentity },
    { label: 'ใส่ 2 ช่องตรงกัน', ok: password.length > 0 && password === confirm },
  ];
}
