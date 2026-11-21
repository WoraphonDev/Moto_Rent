// ยืนยันตัวตน 2 ชั้นของเจ้าของร้าน (mock 7.01 / 7.W1)
import type { INestApplication } from '@nestjs/common';
import { createDb, userTotp } from '@rental/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentStep, totpCode } from '../src/auth/totp.js';
import { enableTotp, json, nobody, startApp, suffix, type Agent } from './helpers.js';

let app: INestApplication;
const device = () => request.agent(app.getHttpServer());
const PASSWORD = 'Owner-island-2026';

/** รหัสของช่วงเวลาถัดจากที่ใช้ไปล่าสุด (ฐานข้อมูลไม่ยอมให้ใช้ช่วงเดิมซ้ำ) · รอถ้าเกินช่วงที่ยอม */
async function codeAfter(secret: string, last: { step: number }): Promise<string> {
  let step = Math.max(currentStep(), last.step + 1);
  while (step > currentStep() + 1) {
    await new Promise((r) => setTimeout(r, 1000));
    step = Math.max(currentStep(), last.step + 1);
  }
  last.step = step;
  return totpCode(secret, step);
}

async function newOwner(tag: string): Promise<{ pc: Agent; username: string }> {
  const pc = device();
  const s = suffix();
  const username = `${tag}.${s}`;
  const r = await pc.post('/v1/auth/signup').set(json).send({ shopName: `2FA ${s}`, slug: `${tag}-${s}`, username, displayName: 'x', password: PASSWORD });
  expect(r.status).toBe(201);
  return { pc, username };
}

beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => {
  await app.close();
});

describe('เจ้าของร้านเข้าจากเครื่องใหม่', () => {
  let first: { pc: Agent; username: string };
  it('ยังไม่เปิด 2 ชั้น: เครื่องใหม่เข้าไม่ได้ (คนที่ได้รหัสผ่านไปอนุมัติเครื่องตัวเองไม่ได้) · เครื่องเดิมเข้าได้', async () => {
    first = await newOwner('nt');
    const { pc, username } = first;
    const r = await device().post('/v1/auth/login').set(json).send({ identifier: username, password: PASSWORD });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('totp_setup_required');
    expect((await pc.post('/v1/auth/login').set(json).send({ identifier: username, password: PASSWORD })).status).toBe(200);
  });

  it('เปิดแล้ว: รหัสผ่านถูกยังไม่พอ · รหัสผิดเข้าไม่ได้ · รหัสถูกเข้าได้และจำเครื่องไว้ · ใช้รหัสเดิมซ้ำไม่ได้', { timeout: 70_000 }, async () => {
    const { pc, username } = await newOwner('wt');
    const { secret } = await enableTotp(pc);
    const last = { step: currentStep() };

    const phone = device();
    const r = await phone.post('/v1/auth/login').set(json).send({ identifier: username, password: PASSWORD, deviceName: 'มือถือใหม่' });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ status: 'totp_required', expiresInSeconds: 600 });
    expect((await phone.get('/v1/auth/me')).status).toBe(401);

    const wrong = await phone.post('/v1/auth/login/totp').set(json).send({ code: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('totp_invalid');

    const code = await codeAfter(secret, last);
    const ok = await phone.post('/v1/auth/login/totp').set(json).send({ code });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'ok', role: 'owner' });
    expect((await phone.get('/v1/auth/me')).status).toBe(200);

    // เครื่องนี้อนุมัติแล้ว: ครั้งหน้าไม่ถามรหัส
    const again = await phone.post('/v1/auth/login').set(json).send({ identifier: username, password: PASSWORD });
    expect(again.status).toBe(200);

    // คนอื่นที่ได้รหัส 6 หลักชุดเดียวกันไป (ดักจากหน้าจอ) ใช้ซ้ำไม่ได้
    const thief = device();
    expect((await thief.post('/v1/auth/login').set(json).send({ identifier: username, password: PASSWORD })).status).toBe(202);
    expect((await thief.post('/v1/auth/login/totp').set(json).send({ code })).status).toBe(401);
  });

  it('มือถือหาย: ใช้รหัสสำรองแทนได้ครั้งเดียว', async () => {
    const { pc, username } = await newOwner('bk');
    const { backupCodes } = await enableTotp(pc);
    const laptop = device();
    expect((await laptop.post('/v1/auth/login').set(json).send({ identifier: username, password: PASSWORD })).status).toBe(202);
    const ok = await laptop.post('/v1/auth/login/totp').set(json).send({ backupCode: backupCodes[0]!.toLowerCase() });
    expect(ok.status).toBe(200);

    const other = device();
    expect((await other.post('/v1/auth/login').set(json).send({ identifier: username, password: PASSWORD })).status).toBe(202);
    expect((await other.post('/v1/auth/login/totp').set(json).send({ backupCode: backupCodes[0] })).status).toBe(401);
    expect((await pc.get('/v1/auth/2fa')).body).toMatchObject({ enabled: true, backupLeft: 7, required: true });
  });

  it('ใส่ผิดครบ 5 ครั้ง: พักไว้ แม้รหัสถูกก็ใช้ไม่ได้', async () => {
    const { pc, username } = first; // ร้านจากเทสต์แรก (สมัครร้านได้ 5 ครั้ง/ชม. ต่อ IP)
    const { secret } = await enableTotp(pc);
    const phone = device();
    await phone.post('/v1/auth/login').set(json).send({ identifier: username, password: PASSWORD });
    for (let i = 0; i < 5; i++) {
      expect((await phone.post('/v1/auth/login/totp').set(json).send({ code: '111111' })).status).toBe(401);
    }
    const locked = await phone.post('/v1/auth/login/totp').set(json).send({ code: totpCode(secret, currentStep() + 1) });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe('totp_locked');
  });
});

describe('งานสำคัญถามรหัสซ้ำ (15 นาที)', () => {
  it('เข้าระบบด้วยรหัสผ่านบนเครื่องเดิม = ยังไม่ยืนยัน → เชิญพนักงานไม่ได้จนกว่าจะใส่รหัส', { timeout: 70_000 }, async () => {
    const { pc, username } = await newOwner('su');
    const { secret } = await enableTotp(pc);
    const last = { step: currentStep() };
    // เข้าใหม่บนเครื่องเดิม: ได้ session ใหม่ที่ยังไม่ยืนยัน 2 ชั้น
    await pc.post('/v1/auth/logout').set(nobody);
    expect((await pc.post('/v1/auth/login').set(json).send({ identifier: username, password: PASSWORD })).status).toBe(200);
    const invite = () => pc.post('/v1/invitations').set(json).send({ username: `st.${suffix()}`, displayName: 'x', role: 'staff' });
    const blocked = await invite();
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('totp_required');

    expect((await pc.post('/v1/auth/2fa/verify').set(json).send({ code: '123456' })).status).toBe(401);
    expect((await pc.post('/v1/auth/2fa/verify').set(json).send({ code: await codeAfter(secret, last) })).status).toBe(204);
    expect((await invite()).status).toBe(201);
  });

  it('เปิดซ้ำตอนเปิดอยู่ไม่ได้ · ปิดต้องใช้ทั้งรหัสผ่านและรหัสสำรอง/รหัส 6 หลัก · ปิดแล้วงานสำคัญถูกบล็อกอีก', async () => {
    const { pc } = await newOwner('ds');
    const { backupCodes } = await enableTotp(pc);
    // กันคนที่ยืมเครื่องไปผูกมือถือตัวเองแทน
    expect((await pc.post('/v1/auth/2fa/setup').set(nobody)).status).toBe(409);
    expect((await pc.post('/v1/auth/2fa/disable').set(json).send({ password: 'wrong-pass', backupCode: backupCodes[1] })).status).toBe(401);
    expect((await pc.post('/v1/auth/2fa/disable').set(json).send({ password: PASSWORD, backupCode: 'AAAA-AAAA' })).status).toBe(401);
    expect((await pc.post('/v1/auth/2fa/disable').set(json).send({ password: PASSWORD, backupCode: backupCodes[1] })).status).toBe(204);
    const r = await pc.post('/v1/invitations').set(json).send({ username: `st.${suffix()}`, displayName: 'x', role: 'staff' });
    expect(r.body.error).toBe('totp_setup_required');
  });
});

describe('ฐานข้อมูล', () => {
  it('API อ่านตาราง secret ตรงๆ ไม่ได้ (ต้องผ่านฟังก์ชันเท่านั้น)', async () => {
    const db = createDb(process.env.DATABASE_APP_URL!, 1);
    try {
      await expect(db.select().from(userTotp)).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
    } finally {
      await db.$client.end();
    }
  });
});
