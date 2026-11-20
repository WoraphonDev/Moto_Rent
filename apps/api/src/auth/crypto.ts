import { createHash, randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/** token ที่ส่งให้เครื่องลูกข่าย (session, เครื่อง, ลิงก์เชิญ) · ฐานข้อมูลเก็บเฉพาะ sha256 */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** รหัสยืนยันเครื่อง 4 ตัว · ตัดตัวที่สับสนง่าย (0/O, 1/I) */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function approvalCode(): string {
  return Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  // ไม่มีผู้ใช้/ยังไม่ตั้งรหัส: ยังเสียเวลาเท่ากับตรวจจริง กันการเดาว่ามีชื่อผู้ใช้นี้หรือไม่จากเวลาตอบ
  if (!stored) {
    await verify(DUMMY_HASH, password).catch(() => false);
    return false;
  }
  return verify(stored, password).catch(() => false);
}

const DUMMY_HASH = await hash('dummy-password-for-timing');
