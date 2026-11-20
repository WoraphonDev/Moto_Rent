import { describe, expect, it } from 'vitest';
import { dueAt, lateFee, rentalDaysCharge, total, type RateCard } from '../src/index.ts';

const click: RateCard = { perDay: 25_000, maxDays: 15 }; // ฿250
const due = new Date('2026-11-23T10:30:00+07:00');
const at = (minutesLate: number) => new Date(due.getTime() + minutesLate * 60_000);

describe('rentalDaysCharge', () => {
  it('Click 3 วัน = ฿750', () => {
    expect(rentalDaysCharge(click, 3)).toBe(75_000);
  });
  it('ไม่เกินวันสูงสุดที่ร้านตั้ง', () => {
    expect(() => rentalDaysCharge(click, 16)).toThrow(RangeError);
  });
  it('รับเฉพาะจำนวนวันเต็ม', () => {
    expect(() => rentalDaysCharge(click, 1.5)).toThrow(RangeError);
  });
});

describe('dueAt', () => {
  it('รับ 20 พ.ย. 10:30 เช่า 3 วัน คืน 23 พ.ย. 10:30', () => {
    expect(dueAt(new Date('2026-11-20T10:30:00+07:00'), 3).toISOString()).toBe(due.toISOString());
  });
});

describe('lateFee (ค่าเริ่มต้น: ผ่อนผัน 60 นาที · ไม่เกิน 4 ชม. ครึ่งวัน)', () => {
  it('คืนตรงเวลาหรือในช่วงผ่อนผันไม่คิด', () => {
    expect(lateFee(click, due, at(-30))).toBe(0);
    expect(lateFee(click, due, at(60))).toBe(0);
  });
  it('เลย 1:40 ชม. (ตัวอย่างใน mock) คิดครึ่งวัน ฿125', () => {
    expect(lateFee(click, due, at(100))).toBe(12_500);
  });
  it('เลยเกิน 4 ชม. คิดเต็มวันตามจำนวนวันที่เลย', () => {
    expect(lateFee(click, due, at(241))).toBe(25_000);
    expect(lateFee(click, due, at(1441))).toBe(50_000);
  });
  it('ร้านเปลี่ยนกฎได้', () => {
    expect(lateFee(click, due, at(100), { graceMinutes: 0, halfDayUntilMinutes: 0 })).toBe(25_000);
  });
});

describe('total', () => {
  const lines = [
    { label: 'Click 5 วัน', quantity: 1, unitPrice: 25_000, units: 5, amount: 125_000 },
    { label: 'ชุดดำน้ำ', quantity: 1, unitPrice: 0, units: 1, amount: 84_000 },
    { label: 'ส่วนเพิ่ม', quantity: 1, unitPrice: 0, units: 1, amount: 26_000 },
  ];
  it('บิลห้อง 305 ลดเหลือ ฿2,150', () => {
    expect(total(lines, 20_000)).toBe(215_000);
  });
  it('ส่วนลดติดลบหรือเกินยอดไม่ได้', () => {
    expect(() => total(lines, -1)).toThrow(RangeError);
    expect(() => total(lines, 300_000)).toThrow(RangeError);
  });
});
