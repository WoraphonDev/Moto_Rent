import { describe, expect, it } from 'vitest';
import { safeNext } from '@/lib/safe-next';

const O = 'https://app.example.test';

describe('safeNext (กัน open redirect หลังเข้าระบบ)', () => {
  it('หน้าในเว็บเดียวกันผ่าน', () => {
    expect(safeNext('/bills/123?x=1#a', O)).toBe('/bills/123?x=1#a');
  });
  it.each(['//evil.com', '/\\evil.com', '/%5Cevil.com', '/\tevil.com', 'https://evil.com', 'javascript:alert(1)', '\\\\evil.com'])('ปฏิเสธ %s', (bad) => {
    const out = safeNext(bad, O);
    expect(new URL(out, O).origin).toBe(O);
  });
  it('ไม่มีค่า = หน้าหลัก', () => {
    expect(safeNext(null, O)).toBe('/');
  });
});
