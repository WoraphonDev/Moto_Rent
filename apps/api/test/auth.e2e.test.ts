// ทดสอบ flow เข้าระบบทั้งเส้นกับฐานข้อมูลและ Valkey จริง (`pnpm db:setup` ก่อน)
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_APP_URL ??= 'postgres://rental_api:rental_api_dev@localhost:54330/rental';
process.env.VALKEY_URL ??= 'redis://localhost:63800';
process.env.COOKIE_SECURE = 'false';

const { createApp } = await import( '../src/bootstrap.js');

const s = randomBytes(3).toString('hex');
let app: INestApplication;

/** เครื่องหนึ่งเครื่อง = cookie jar หนึ่งชุด (agent) */
const device = () => request.agent(app.getHttpServer());
const json = { 'content-type': 'application/json' };
const nobody = { 'x-requested-with': 'fetch' };

beforeAll(async () => {
  // ตัวนับ rate limit อยู่ใน Valkey ข้ามรอบเทสต์ (ทุกคำขอมาจาก IP เดียวกัน) · ล้างก่อนเริ่ม
  const valkey = new Redis(process.env.VALKEY_URL!);
  const keys = await valkey.keys('rl:*');
  if (keys.length) await valkey.del(...keys);
  await valkey.quit();
  app = await createApp();
  await app.init();
});
afterAll(async () => {
  await app.close();
});

describe('health', () => {
  it('/ready ต่อฐานข้อมูลและ Valkey ได้', async () => {
    const r = await request(app.getHttpServer()).get('/ready');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, db: true, valkey: true });
  });
});

describe('สมัครร้าน → เชิญพนักงาน → อนุมัติเครื่อง → เข้าระบบ', () => {
  let ownerPc: ReturnType<typeof device>;
  let nokPhone: ReturnType<typeof device>;
  beforeAll(() => {
    ownerPc = device();
    nokPhone = device();
  });
  const ownerPassword = 'Tao-island-2026';
  let inviteUrl = '';
  let nokId = '';
  let nokDeviceId = '';
  let approvalCode = '';

  it('สมัครร้านใหม่แล้วเข้าระบบเป็นเจ้าของทันที', async () => {
    const r = await ownerPc.post('/v1/auth/signup').set(json).send({
      shopName: 'Koh Tao Rental',
      slug: `kt-${s}`,
      username: `owner.${s}`,
      displayName: 'เจ้าของ',
      password: ownerPassword,
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'ok', role: 'owner' });
    const cookies = r.headers['set-cookie'] as unknown as string[];
    expect(cookies.join(';')).toMatch(/rs=.*HttpOnly/);
    const me = await ownerPc.get('/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.org.name).toBe('Koh Tao Rental');
    expect(me.body.settings).toMatchObject({ maxRentalDays: 15, docRetentionDays: 90 });
  });

  it('ชื่อร้านใน URL ซ้ำไม่ได้', async () => {
    const r = await device().post('/v1/auth/signup').set(json).send({
      shopName: 'Copy', slug: `kt-${s}`, username: `other.${s}`, displayName: 'x', password: 'Another-pass-99',
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('slug_taken');
  });

  it('รหัสผ่านที่มีชื่อผู้ใช้อยู่ข้างในถูกปฏิเสธ', async () => {
    const r = await device().post('/v1/auth/signup').set(json).send({
      shopName: 'Weak', slug: `weak-${s}`, username: `weak${s}`, displayName: 'x', password: `weak${s}123`,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('weak_password');
  });

  it('เจ้าของสร้างลิงก์เชิญ Nok', async () => {
    const r = await ownerPc.post('/v1/invitations').set(json).send({ username: `nok.${s}`, displayName: 'Nok', role: 'staff' });
    expect(r.status).toBe(201);
    expect(r.body.url).toMatch(/\/invite\/[A-Za-z0-9_-]{40,}$/);
    inviteUrl = r.body.url;
  });

  it('เปิดลิงก์เห็นชื่อร้านและบทบาท แล้วตั้งรหัสเอง', async () => {
    const token = inviteUrl.split('/').pop()!;
    const look = await nokPhone.get(`/v1/invitations/${token}`);
    expect(look.body).toMatchObject({ orgName: 'Koh Tao Rental', username: `nok.${s}`, role: 'staff', kind: 'invite' });
    expect(look.body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const acc = await nokPhone.post(`/v1/invitations/${token}/accept`).set(json).send({ password: 'Nok-sunrise-77' });
    expect(acc.status).toBe(200);
    const again = await nokPhone.post(`/v1/invitations/${token}/accept`).set(json).send({ password: 'Nok-sunrise-77' });
    expect(again.status).toBe(404);
  });

  it('Nok เข้าระบบจากมือถือใหม่ = รอเจ้าของอนุมัติ (ยังไม่ได้ session)', async () => {
    const r = await nokPhone.post('/v1/auth/login').set(json).send({ identifier: `NOK.${s}`, password: 'Nok-sunrise-77', deviceName: 'มือถือ Nok' });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('device_pending');
    expect(r.body.approvalCode).toMatch(/^[A-Z2-9]{4}$/);
    nokDeviceId = r.body.deviceId;
    approvalCode = r.body.approvalCode;
    expect((await nokPhone.get('/v1/auth/me')).status).toBe(401);
    const poll = await nokPhone.get('/v1/auth/pending');
    expect(poll.body.status).toBe('device_pending');
  });

  it('พนักงานอนุมัติเครื่องไม่ได้ · เจ้าของต้องใส่รหัสให้ตรง', async () => {
    const members = await ownerPc.get('/v1/members');
    nokId = members.body.members.find((m: { username: string }) => m.username === `nok.${s}`).userId;
    const wrong = await ownerPc.post(`/v1/devices/${nokDeviceId}/approve`).set(json).send({ code: 'ZZZZ' });
    expect(wrong.status).toBe(400);
    const ok = await ownerPc.post(`/v1/devices/${nokDeviceId}/approve`).set(json).send({ code: approvalCode.toLowerCase() });
    expect(ok.status).toBe(204);
  });

  it('มือถือ Nok ที่รออยู่เข้าระบบให้เองหลังอนุมัติ', async () => {
    const poll = await nokPhone.get('/v1/auth/pending');
    expect(poll.body).toMatchObject({ status: 'ok', role: 'staff' });
    const me = await nokPhone.get('/v1/auth/me');
    expect(me.body.user.displayName).toBe('Nok');
  });

  it('พนักงานเปิดหน้าจัดการเครื่องและสร้างลิงก์เชิญไม่ได้', async () => {
    expect((await nokPhone.get('/v1/devices')).status).toBe(403);
    expect((await nokPhone.post('/v1/invitations').set(json).send({ username: `x.${s}`, displayName: 'x', role: 'staff' })).status).toBe(403);
  });

  it('ตัดสิทธิ์เครื่อง = มือถือ Nok หลุดทันที และเข้าใหม่จากเครื่องเดิมไม่ได้', async () => {
    const r = await ownerPc.post(`/v1/devices/${nokDeviceId}/revoke`).set(nobody);
    expect(r.status).toBe(204);
    expect((await nokPhone.get('/v1/auth/me')).status).toBe(401);
    const again = await nokPhone.post('/v1/auth/login').set(json).send({ identifier: `nok.${s}`, password: 'Nok-sunrise-77' });
    expect(again.status).toBe(403);
    expect(again.body.error).toBe('device_revoked');
  });

  it('ลิงก์ตั้งรหัสใหม่: รหัสเดิมใช้ไม่ได้อีก', async () => {
    const link = await ownerPc.post(`/v1/members/${nokId}/reset-link`).set(nobody);
    expect(link.status).toBe(201);
    const token = link.body.url.split('/').pop();
    const newPhone = device();
    expect((await newPhone.get(`/v1/invitations/${token}`)).body.kind).toBe('reset');
    expect((await newPhone.post(`/v1/invitations/${token}/accept`).set(json).send({ password: 'Fresh-start-2027' })).status).toBe(200);
    const old = await newPhone.post('/v1/auth/login').set(json).send({ identifier: `nok.${s}`, password: 'Nok-sunrise-77' });
    expect(old.status).toBe(401);
    const fresh = await newPhone.post('/v1/auth/login').set(json).send({ identifier: `nok.${s}`, password: 'Fresh-start-2027' });
    expect(fresh.status).toBe(202);
  });

  it('ปิดบัญชีแล้วเข้าระบบไม่ได้ แต่ประวัติยังอยู่', async () => {
    expect((await ownerPc.post(`/v1/members/${nokId}/close`).set(nobody)).status).toBe(204);
    const r = await device().post('/v1/auth/login').set(json).send({ identifier: `nok.${s}`, password: 'Fresh-start-2027' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('no_active_membership');
    const list = await ownerPc.get('/v1/members');
    expect(list.body.members.find((m: { userId: string }) => m.userId === nokId).status).toBe('closed');
  });

  it('เจ้าของปิดบัญชีตัวเองไม่ได้', async () => {
    const me = await ownerPc.get('/v1/auth/me');
    expect((await ownerPc.post(`/v1/members/${me.body.user.id}/close`).set(nobody)).status).toBe(400);
  });

  it('ออกจากระบบแล้ว cookie ใช้ต่อไม่ได้', async () => {
    expect((await ownerPc.post('/v1/auth/logout').set(nobody)).status).toBe(204);
    expect((await ownerPc.get('/v1/auth/me')).status).toBe(401);
  });
});

describe('กันการเดารหัส', () => {
  it('ข้อความเดียวกันทั้งชื่อผู้ใช้ไม่มีอยู่และรหัสผิด', async () => {
    const a = await device().post('/v1/auth/login').set(json).send({ identifier: `ghost.${s}`, password: 'whatever-123' });
    const b = await device().post('/v1/auth/login').set(json).send({ identifier: `owner.${s}`, password: 'wrong-password' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it('ผิดครบ 5 ครั้ง: เครื่องใหม่เข้าไม่ได้ (ตอบเหมือนรหัสผิด ไม่บอกว่าถูกล็อก) แต่เครื่องที่เคยอนุมัติยังเข้าได้', async () => {
    const pc = device();
    await pc.post('/v1/auth/signup').set(json).send({
      shopName: 'Lock test', slug: `lock-${s}`, username: `lock.${s}`, displayName: 'x', password: 'Correct-horse-42',
    });
    for (let i = 0; i < 5; i++) {
      const r = await device().post('/v1/auth/login').set(json).send({ identifier: `lock.${s}`, password: `bad-${i}-xxxx` });
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'invalid_credentials' });
    }
    // คนนอก (เครื่องใหม่) ใส่รหัสถูกระหว่างช่วงพัก = เหมือนรหัสผิด · ไม่รู้ว่าบัญชีมีอยู่หรือถูกล็อก
    const stranger = await device().post('/v1/auth/login').set(json).send({ identifier: `lock.${s}`, password: 'Correct-horse-42' });
    expect(stranger.status).toBe(401);
    expect(stranger.body).toEqual({ error: 'invalid_credentials' });
    // เจ้าของบนเครื่องเดิมที่อนุมัติแล้ว ไม่โดนล็อกจากการที่คนอื่นเดารหัส
    const owner = await pc.post('/v1/auth/login').set(json).send({ identifier: `lock.${s}`, password: 'Correct-horse-42' });
    expect(owner.status).toBe(200);
  });

  it('ชื่อผู้ใช้ต้องมีตัวอักษร (กันชนกับเบอร์โทรของคนอื่น)', async () => {
    const r = await device().post('/v1/auth/signup').set(json).send({
      shopName: 'Digits', slug: `dig-${s}`, username: '0812345678', displayName: 'x', password: 'Another-pass-99',
    });
    expect(r.status).toBe(400);
  });

  it('POST ที่ไม่ใช่ JSON ถูกปฏิเสธ (กัน CSRF จากฟอร์มเว็บอื่น)', async () => {
    const r = await device().post('/v1/auth/login').set('content-type', 'application/x-www-form-urlencoded').send('identifier=a&password=b');
    expect(r.status).toBe(415);
  });
});
