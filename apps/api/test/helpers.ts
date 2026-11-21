import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { currentStep, totpCode } from '../src/auth/totp.js';

process.env.DATABASE_APP_URL ??= 'postgres://rental_api:rental_api_dev@localhost:54330/rental';
process.env.VALKEY_URL ??= 'redis://localhost:63800';
process.env.COOKIE_SECURE = 'false';

export const json = { 'content-type': 'application/json' };
export const nobody = { 'x-requested-with': 'fetch' };
export type Agent = ReturnType<typeof request.agent>;

export async function startApp(): Promise<INestApplication> {
  // ตัวนับ rate limit อยู่ใน Valkey ข้ามรอบเทสต์ (ทุกคำขอมาจาก IP เดียวกัน) · ล้างก่อนเริ่ม
  const valkey = new Redis(process.env.VALKEY_URL!);
  const keys = await valkey.keys('rl:*');
  if (keys.length) await valkey.del(...keys);
  await valkey.quit();
  const { createApp } = await import('../src/bootstrap.js');
  const app = await createApp();
  await app.init();
  return app;
}

export const suffix = () => randomBytes(3).toString('hex');

/** สมัครร้านใหม่ → คืนเครื่องของเจ้าของที่เข้าระบบแล้ว */
export async function signupShop(app: INestApplication, s: string): Promise<Agent> {
  const owner = request.agent(app.getHttpServer());
  const r = await owner.post('/v1/auth/signup').set(json).send({
    shopName: `Shop ${s}`,
    slug: `shop-${s}`,
    username: `own.${s}`,
    displayName: 'เจ้าของ',
    password: 'Owner-island-2026',
  });
  if (r.status !== 201) throw new Error(`signup failed: ${r.status} ${JSON.stringify(r.body)}`);
  // เจ้าของร้านต้องเปิดยืนยันตัวตน 2 ชั้นก่อนอนุมัติเครื่อง/เชิญพนักงาน (session นี้นับว่ายืนยันแล้ว 15 นาที)
  await enableTotp(owner);
  return owner;
}

const secrets = new WeakMap<Agent, string>();

/** เปิด 2 ชั้นให้ผู้ใช้ของเครื่องนี้ · คืน secret และรหัสสำรอง */
export async function enableTotp(agent: Agent): Promise<{ secret: string; backupCodes: string[] }> {
  const setup = await agent.post('/v1/auth/2fa/setup').set(nobody);
  if (setup.status !== 200) throw new Error(`2fa setup failed: ${setup.status} ${JSON.stringify(setup.body)}`);
  const secret = setup.body.secret as string;
  const en = await agent.post('/v1/auth/2fa/enable').set(json).send({ code: totpCode(secret, currentStep()) });
  if (en.status !== 200) throw new Error(`2fa enable failed: ${en.status} ${JSON.stringify(en.body)}`);
  secrets.set(agent, secret);
  return { secret, backupCodes: en.body.backupCodes };
}

export function totpSecretOf(agent: Agent): string {
  const s = secrets.get(agent);
  if (!s) throw new Error('2fa not enabled for this agent');
  return s;
}

/** เชิญพนักงาน → ตั้งรหัส → เข้าระบบ → เจ้าของอนุมัติเครื่อง → คืนเครื่องของพนักงานที่เข้าระบบแล้ว */
export async function addStaff(app: INestApplication, owner: Agent, username: string): Promise<Agent> {
  const inv = await owner.post('/v1/invitations').set(json).send({ username, displayName: username, role: 'staff' });
  const token = String(inv.body.url).split('/').pop();
  const staff = request.agent(app.getHttpServer());
  await staff.post(`/v1/invitations/${token}/accept`).set(json).send({ password: 'Staff-sunrise-77' });
  const login = await staff.post('/v1/auth/login').set(json).send({ identifier: username, password: 'Staff-sunrise-77' });
  await owner.post(`/v1/devices/${login.body.deviceId}/approve`).set(json).send({ code: login.body.approvalCode });
  const ok = await staff.get('/v1/auth/pending');
  if (ok.body.status !== 'ok') throw new Error(`staff login failed: ${JSON.stringify(ok.body)}`);
  return staff;
}
