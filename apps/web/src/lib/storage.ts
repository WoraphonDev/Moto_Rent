/** localStorage ใช้ได้ไม่เสมอ (โหมดส่วนตัว / ถูกบล็อก) · พังเงียบแทนที่จะทำให้หน้าเสีย */
export function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* ไม่จำก็ได้ */
  }
}

export const REMEMBERED_USERNAME = 'rental.username';

/** ล็อกจอของเครื่องนี้ (จำไว้แม้รีโหลดหน้า) */
export const LOCK_KEY = 'rental.locked';
export const ACTIVITY_KEY = 'rental.lastActivity';

/** เพิ่งเข้าระบบด้วยรหัสผ่าน: ล้างสถานะล็อกจอเดิม และเริ่มนับเวลาไม่ได้แตะใหม่ */
export function resetIdleLock(): void {
  writeLocal(LOCK_KEY, null);
  writeLocal(ACTIVITY_KEY, String(Date.now()));
}
