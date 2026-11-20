import { z } from 'zod';

/** กฎรหัสผ่านเดียวกับหน้าตั้งรหัสใน mock: อย่างน้อย 8 ตัว และไม่ใช่ชื่อผู้ใช้/เบอร์โทร */
export function passwordSchema() {
  return z.string().min(8, 'password_too_short').max(128, 'password_too_long');
}

export function passwordProblems(password: string, avoid: Array<string | null | undefined>): string[] {
  const p = password.toLowerCase();
  const problems: string[] = [];
  for (const a of avoid) {
    if (a && a.length >= 3 && p.includes(a.toLowerCase().replace(/[^a-z0-9]/g, ''))) problems.push('password_contains_identity');
  }
  if (/^(.)\1+$/.test(password) || /^(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer|pass)/i.test(password)) {
    problems.push('password_too_common');
  }
  return [...new Set(problems)];
}
