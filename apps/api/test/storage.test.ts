// การเลือกที่เก็บไฟล์: production ต้องใช้ S3/R2 · ยกเว้นตั้งใจเปิด ALLOW_LOCAL_STORAGE (ช่วงทดลองเครื่องเดียว)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorage } from '../src/common/storage.js';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_APP_URL: 'postgres://u:p@localhost:5432/x', VALKEY_URL: 'redis://localhost:6379' };
const prev = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = prev;
  vi.restoreAllMocks();
});

describe('createStorage', () => {
  it('production ไม่มี S3 และไม่ได้เปิดสวิตช์ → ไม่ยอมเริ่ม', () => {
    process.env.NODE_ENV = 'production';
    expect(() => createStorage(loadConfig({ ...base, NODE_ENV: 'production', TOTP_ENC_KEY: Buffer.alloc(32, 1).toString('base64') }))).toThrow(/S3_BUCKET is required/);
  });

  it('production เปิด ALLOW_LOCAL_STORAGE → ใช้ดิสก์ และเตือน', () => {
    process.env.NODE_ENV = 'production';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = createStorage(loadConfig({ ...base, NODE_ENV: 'production', TOTP_ENC_KEY: Buffer.alloc(32, 1).toString('base64'), ALLOW_LOCAL_STORAGE: 'true', STORAGE_DIR: '/tmp/x' }));
    expect(s.constructor.name).toMatch(/^LocalStorage/);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/LOCAL disk/));
  });
});
