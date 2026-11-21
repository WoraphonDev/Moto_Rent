import { createHash } from 'node:crypto';
import { z } from 'zod';

const schema = z.object({
  DATABASE_APP_URL: z.string().url(),
  VALKEY_URL: z.string().url(),
  API_PORT: z.coerce.number().int().default(4100),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** อายุสูงสุดของ session (ชั่วโมง) */
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  /** ไม่ได้ใช้นานเกินนี้ (นาที) session หมดอายุที่ฝั่งเซิร์ฟเวอร์ · การล็อกจอ 15 นาทีทำที่ฝั่งแอป */
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(240),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  /** URL หน้าเว็บสำหรับสร้างลิงก์เชิญ */
  WEB_ORIGIN: z.string().url().default('http://127.0.0.1:3100'),
  /** หน้าจองสาธารณะของร้าน (เฟส 3) · ค่าเริ่มต้น = WEB_ORIGIN */
  BOOKING_ORIGIN: z.string().url().optional(),
  STORAGE_DIR: z.string().default('.data/uploads'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  NODE_ENV: z.string().optional(),
  /** กุญแจเข้ารหัส secret ของยืนยันตัวตน 2 ชั้น (base64 ยาว 32 ไบต์) · production ต้องตั้ง */
  TOTP_ENC_KEY: z.string().optional(),
  /** เจ้าของร้านต้องเปิดยืนยันตัวตน 2 ชั้นก่อนเข้าจากเครื่องใหม่ */
  OWNER_TOTP_REQUIRED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    const key = parsed.data.TOTP_ENC_KEY ? Buffer.from(parsed.data.TOTP_ENC_KEY, 'base64') : null;
    if (!key || key.length !== 32) throw new Error('invalid environment: TOTP_ENC_KEY (base64, 32 bytes) is required in production');
  }
  return parsed.data;
}

/** กุญแจของ TOTP · เครื่องพัฒนาไม่ตั้งได้ (ใช้กุญแจคงที่สำหรับพัฒนาเท่านั้น) */
export function totpKey(config: Config): Buffer {
  if (config.TOTP_ENC_KEY) {
    const key = Buffer.from(config.TOTP_ENC_KEY, 'base64');
    if (key.length !== 32) throw new Error('TOTP_ENC_KEY must be 32 bytes (base64)');
    return key;
  }
  if (config.NODE_ENV === 'production') throw new Error('TOTP_ENC_KEY is required in production');
  return createHash('sha256').update('rental-dev-only-totp-key').digest();
}

export const CONFIG = Symbol('CONFIG');
