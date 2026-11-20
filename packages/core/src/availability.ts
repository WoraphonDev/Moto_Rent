import { assertInterval, endMs, overlaps, type Interval } from './interval.ts';

/**
 * การจอง/เช่าที่กันของไว้ · ใช้ทั้งของรายชิ้น (quantity = 1 ต่อชิ้น) และของนับจำนวน (เช่น ตีนกบ L × 3)
 * id ใช้ชี้ว่าชนกับรายการไหน และใช้ตัดตัวเองออกตอนแก้ไขรายการเดิม
 */
export interface Hold extends Interval {
  id: string;
  quantity: number;
}

/** ของรายชิ้น: รายการที่ชนกับช่วงที่ขอ (ไม่ว่าง = มีอย่างน้อย 1 รายการ) */
export function conflictsFor(holds: readonly Hold[], wanted: Interval, ignoreId?: string): Hold[] {
  assertInterval(wanted);
  return holds.filter((h) => h.id !== ignoreId && overlaps(h, wanted));
}

/**
 * ของนับจำนวน: จำนวนที่ยังว่างตลอดช่วงที่ขอ = ทั้งหมด − ยอดที่ถูกกันพร้อมกันสูงสุดในช่วงนั้น
 * ใช้ sweep line: ไม่ใช่ผลรวมทุกรายการที่ชน เพราะรายการที่ไม่ซ้อนเวลากันใช้ของชุดเดียวกันได้
 */
export function availableQuantity(
  total: number,
  holds: readonly Hold[],
  wanted: Interval,
  ignoreId?: string,
): number {
  assertInterval(wanted);
  const relevant = conflictsFor(holds, wanted, ignoreId);
  const from = wanted.start.getTime();
  const to = endMs(wanted);
  const events: Array<[number, number]> = [];
  for (const h of relevant) {
    events.push([Math.max(h.start.getTime(), from), h.quantity]);
    const e = Math.min(endMs(h), to);
    if (e !== Number.POSITIVE_INFINITY) events.push([e, -h.quantity]);
  }
  // คืนก่อนรับเมื่อเวลาเท่ากัน (ครึ่งเปิด)
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > peak) peak = current;
  }
  return Math.max(0, total - peak);
}
