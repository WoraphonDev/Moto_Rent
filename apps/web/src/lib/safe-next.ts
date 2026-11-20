/**
 * ปลายทางหลังเข้าระบบต้องเป็นหน้าในเว็บเดียวกันเท่านั้น (กัน open redirect เช่น /\evil.com, /%09/evil.com)
 * แปลงเป็น URL เต็มแล้วเทียบ origin จริง แทนการดูแค่ตัวอักษรนำหน้า
 */
export function safeNext(next: string | null, origin = window.location.origin): string {
  if (!next) return '/';
  try {
    const u = new URL(next, origin);
    if (u.origin !== origin) return '/';
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return '/';
  }
}
