import { describe, expect, it } from 'vitest';
import { availableQuantity, conflictsFor, type Hold } from '../src/index.ts';

const d = (iso: string) => new Date(`${iso}+07:00`);
const hold = (id: string, start: string, end: string | null, quantity = 1): Hold => ({
  id,
  start: d(start),
  end: end === null ? null : d(end),
  quantity,
});

describe('conflictsFor (ของรายชิ้น)', () => {
  const holds = [hold('emma', '2026-11-20T10:30', '2026-11-23T10:30'), hold('anna', '2026-11-25T13:00', '2026-11-29T13:00')];

  it('คืน 10:30 แล้วรับต่อ 10:30 ไม่ชน', () => {
    expect(conflictsFor(holds, { start: d('2026-11-23T10:30'), end: d('2026-11-24T10:30') })).toEqual([]);
  });

  it('ช่วงที่ทับกันแม้นาทีเดียวถือว่าชน', () => {
    const c = conflictsFor(holds, { start: d('2026-11-23T10:29'), end: d('2026-11-24T10:30') });
    expect(c.map((h) => h.id)).toEqual(['emma']);
  });

  it('ไม่นับรายการที่กำลังแก้ไขอยู่ (ต่อวัน)', () => {
    const c = conflictsFor(holds, { start: d('2026-11-20T10:30'), end: d('2026-11-25T10:30') }, 'emma');
    expect(c).toEqual([]);
  });

  it('สัญญาที่ยังไม่กำหนดวันคืนกันของไปตลอด', () => {
    const open = [hold('lukas', '2026-11-18T09:00', null)];
    expect(conflictsFor(open, { start: d('2026-12-30T09:00'), end: d('2026-12-31T09:00') })).toHaveLength(1);
  });

  it('ปฏิเสธช่วงที่จบก่อนเริ่ม', () => {
    expect(() => conflictsFor(holds, { start: d('2026-11-23T10:00'), end: d('2026-11-22T10:00') })).toThrow(RangeError);
  });
});

describe('availableQuantity (ของนับจำนวน)', () => {
  // ตีนกบไซส์ L มี 4 คู่
  const holds = [
    hold('a', '2026-11-20T09:00', '2026-11-21T09:00', 2),
    hold('b', '2026-11-21T09:00', '2026-11-22T09:00', 3),
    hold('c', '2026-11-20T12:00', '2026-11-20T18:00', 1),
  ];

  it('รายการที่ไม่ซ้อนเวลากันใช้ของชุดเดียวกันได้', () => {
    // a กับ b ต่อกันพอดี ไม่ซ้อน → ยอดสูงสุดคือ max(2+1, 3) = 3
    expect(availableQuantity(4, holds, { start: d('2026-11-20T00:00'), end: d('2026-11-23T00:00') })).toBe(1);
  });

  it('ดูเฉพาะช่วงที่ขอ', () => {
    expect(availableQuantity(4, holds, { start: d('2026-11-20T19:00'), end: d('2026-11-21T08:00') })).toBe(2);
  });

  it('ไม่ติดลบเมื่อจองเกิน', () => {
    expect(availableQuantity(2, holds, { start: d('2026-11-21T10:00'), end: d('2026-11-21T11:00') })).toBe(0);
  });
});
