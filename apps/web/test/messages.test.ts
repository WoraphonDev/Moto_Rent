import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { messageFor, passwordChecks } from '@/lib/messages';

describe('messageFor', () => {
  it('แปลง code จาก API เป็นข้อความไทย', () => {
    expect(messageFor(new ApiError(401, 'invalid_credentials'))).toBe('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  });
  it('บัญชีล็อกบอกเวลาที่ปลดล็อก', () => {
    const msg = messageFor(new ApiError(423, 'account_locked', { lockedUntil: '2026-11-21T03:15:00.000Z' }));
    expect(msg).toMatch(/ถูกล็อกชั่วคราว ถึง .+ และแจ้งเจ้าของร้านแล้ว/);
  });
  it('code ที่ไม่รู้จักยังแสดงได้', () => {
    expect(messageFor(new ApiError(500, 'something_new'))).toContain('something_new');
  });
});

describe('passwordChecks', () => {
  it('ผ่านครบเมื่อยาวพอ ไม่มีชื่อผู้ใช้ และพิมพ์ตรงกัน', () => {
    expect(passwordChecks('Sunrise-island-7', 'Sunrise-island-7', ['nok.kt']).every((c) => c.ok)).toBe(true);
  });
  it('จับรหัสที่มีชื่อผู้ใช้อยู่ข้างใน', () => {
    const r = passwordChecks('noknok-1234', 'noknok-1234', ['nok.kt']);
    expect(r.find((c) => c.label.includes('ชื่อผู้ใช้'))!.ok).toBe(true);
    const bad = passwordChecks('my-nokkt-pass', 'my-nokkt-pass', ['nok.kt']);
    expect(bad.find((c) => c.label.includes('ชื่อผู้ใช้'))!.ok).toBe(false);
  });
  it('สองช่องไม่ตรงกัน', () => {
    expect(passwordChecks('Sunrise-island-7', 'Sunrise-island-8', []).at(-1)!.ok).toBe(false);
  });
});
