/** ช่วงเวลาแบบครึ่งเปิด [start, end) · end = null คือยังไม่กำหนดวันจบ (ถือว่าไม่สิ้นสุด) */
export interface Interval {
  start: Date;
  end: Date | null;
}

const FOREVER = Number.POSITIVE_INFINITY;

export function endMs(i: Interval): number {
  return i.end === null ? FOREVER : i.end.getTime();
}

export function assertInterval(i: Interval): void {
  if (Number.isNaN(i.start.getTime())) throw new RangeError('interval start is invalid');
  if (i.end !== null && !(i.end.getTime() > i.start.getTime())) {
    throw new RangeError('interval end must be after start');
  }
}

/** ชนกันเมื่อมีเวลาร่วมกันจริง · คืนรถ 10:00 แล้วอีกคนรับ 10:00 ไม่ถือว่าชน */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < endMs(b) && b.start.getTime() < endMs(a);
}
