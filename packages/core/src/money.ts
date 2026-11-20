/**
 * เงินเก็บเป็นจำนวนเต็มหน่วยย่อยเสมอ (สตางค์ / cent) เพื่อไม่ให้ทศนิยมเพี้ยน
 * สกุลเงินผูกกับร้าน (orgs.currency) จึงไม่ต้องพกไปกับทุกตัวเลข
 */
export type Minor = number;

export function assertMinor(value: number, label = 'amount'): Minor {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be an integer in minor units, got ${value}`);
  }
  return value;
}

/** ปัดครึ่งขึ้น (half-up) สำหรับผลคูณที่มีเศษ เช่น ครึ่งวันของ 25,050 สตางค์ */
export function roundMinor(value: number): Minor {
  return Math.sign(value) * Math.round(Math.abs(value));
}

export function sumMinor(values: readonly Minor[]): Minor {
  return values.reduce((a, b) => a + b, 0);
}
