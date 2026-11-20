import type { AssetState, LineKind, PaymentMethod } from './api';

/** หน่วยย่อย (สตางค์) → "฿1,350" · ตัดทศนิยมเมื่อเป็นจำนวนเต็มบาท */
export function baht(minor: number): string {
  const v = minor / 100;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '−' : ''}฿${s}`;
}

/** ข้อความที่พนักงานพิมพ์ ("250", "1,350.50") → หน่วยย่อย · พิมพ์ผิด = null */
export function parseBaht(input: string): number | null {
  const clean = input.replace(/[฿,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

export function timeText(iso: string): string {
  return new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

export function dateText(iso: string): string {
  // "2026-11-21" (วันที่ล้วน) ให้เป็นวันนั้นตามเวลาท้องถิ่น ไม่ใช่เที่ยงคืน UTC ที่อาจเลื่อนวัน
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function dateTimeText(iso: string): string {
  return `${dateText(iso)} ${timeText(iso)}`;
}

/** "เลย 1:30 ชม." / "เลย 2 วัน" */
export function overdueText(dueIso: string, now = Date.now()): string {
  const min = Math.max(0, Math.floor((now - new Date(dueIso).getTime()) / 60_000));
  if (min >= 1440) return `เลย ${Math.floor(min / 1440)} วัน`;
  return `เลย ${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} ชม.`;
}

/** วันคืน: วันนี้แสดงเวลา · วันอื่นแสดงวันที่ */
export function dueText(dueIso: string, now = new Date()): string {
  const d = new Date(dueIso);
  return d.toDateString() === now.toDateString() ? `คืน ${timeText(dueIso)}` : `คืน ${dateText(dueIso)}`;
}

export const STATE_LABEL: Record<AssetState, string> = { available: 'ว่าง', rented: 'เช่าอยู่', overdue: 'เลยกำหนด', maintenance: 'ซ่อม' };
/** คลาส badge ตามสถานะ (สีพาสเทล + คำกำกับ ไม่ใช้สีอย่างเดียว) */
export const STATE_BADGE: Record<AssetState, string> = { available: 'badge-ok', rented: 'badge-info', overdue: 'badge-danger', maintenance: 'badge-neutral' };

export const METHOD_LABEL: Record<PaymentMethod, string> = { cash: 'เงินสด', promptpay: 'PromptPay', transfer: 'โอน', card: 'บัตร' };

export const LINE_LABEL: Record<LineKind, string> = {
  rental: 'ค่าเช่า',
  extension: 'ต่อวัน',
  late_fee: 'คืนช้า',
  fuel: 'น้ำมัน',
  damage: 'ค่าเสียหาย',
  gear: 'อุปกรณ์',
  discount: 'ส่วนลด',
  other: 'อื่นๆ',
};

/** id ของสัญญาสร้างที่เครื่อง · ส่งซ้ำตอนเน็ตหลุดแล้วไม่เกิดสัญญาซ้อน */
export function newId(): string {
  return crypto.randomUUID();
}
