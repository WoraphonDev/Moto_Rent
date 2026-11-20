import { assertMinor, roundMinor, sumMinor, type Minor } from './money.ts';

/** ราคาต่อหน่วยของประเภทของให้เช่า · ร้านตั้งเองได้ ตอนนี้รองรับรายวัน (รายชั่วโมง/สัปดาห์เพิ่มทีหลังโดยไม่เปลี่ยนรูปข้อมูล) */
export interface RateCard {
  perDay: Minor;
  /** จำนวนวันสูงสุดต่อสัญญา (ร้านต้นแบบ: 15) · null = ไม่จำกัด */
  maxDays: number | null;
}

/**
 * กฎคืนช้า (ร้านตั้งเอง)
 * - เลยไม่เกิน graceMinutes: ไม่คิด
 * - เลยไม่เกิน halfDayUntilMinutes: คิดครึ่งวัน
 * - เกินกว่านั้น: คิดเต็มวันตามจำนวนวันที่เลย (ปัดขึ้น)
 */
export interface LateFeePolicy {
  graceMinutes: number;
  halfDayUntilMinutes: number;
}

export const DEFAULT_LATE_FEE_POLICY: LateFeePolicy = { graceMinutes: 60, halfDayUntilMinutes: 240 };

export interface LineQuote {
  label: string;
  quantity: number;
  unitPrice: Minor;
  units: number;
  amount: Minor;
}

export function rentalDaysCharge(rate: RateCard, days: number, quantity = 1): Minor {
  assertMinor(rate.perDay, 'perDay');
  if (!Number.isInteger(days) || days < 1) throw new RangeError('days must be a positive integer');
  if (rate.maxDays !== null && days > rate.maxDays) {
    throw new RangeError(`days exceeds maximum of ${rate.maxDays}`);
  }
  if (!Number.isInteger(quantity) || quantity < 1) throw new RangeError('quantity must be a positive integer');
  return rate.perDay * days * quantity;
}

/** วันคืน = เวลารับ + จำนวนวัน × 24 ชม. (เวลาเดิมของวัน) */
export function dueAt(start: Date, days: number): Date {
  return new Date(start.getTime() + days * 86_400_000);
}

export function lateFee(rate: RateCard, due: Date, returnedAt: Date, policy: LateFeePolicy = DEFAULT_LATE_FEE_POLICY): Minor {
  const lateMinutes = Math.floor((returnedAt.getTime() - due.getTime()) / 60_000);
  if (lateMinutes <= policy.graceMinutes) return 0;
  if (lateMinutes <= policy.halfDayUntilMinutes) return roundMinor(rate.perDay / 2);
  return rate.perDay * Math.ceil(lateMinutes / 1440);
}

export function total(lines: readonly LineQuote[], discount: Minor = 0): Minor {
  assertMinor(discount, 'discount');
  const gross = sumMinor(lines.map((l) => l.amount));
  if (discount < 0 || discount > gross) throw new RangeError('discount must be between 0 and the gross total');
  return gross - discount;
}
