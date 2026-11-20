// regression จากการตรวจความปลอดภัย: โหมดลูกค้า (หน้าเซ็นสัญญา) ถูกบังคับที่เซิร์ฟเวอร์
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json, nobody, signupShop, startApp, suffix, type Agent } from './helpers.js';

let app: INestApplication;
let owner: Agent;
let rentalId = '';
let otherCustomerId = '';

beforeAll(async () => {
  app = await startApp();
  owner = await signupShop(app, suffix());
  const t = await owner.post('/v1/asset-types').set(json).send({ name: 'Click', tracking: 'unit', codePrefix: 'C-', pricePerDay: 25_000 });
  const a = await owner.post('/v1/assets').set(json).send({ assetTypeId: t.body.id });
  const c = await owner.post('/v1/customers').set(json).send({ fullName: 'Emma Larsen' });
  const other = await owner.post('/v1/customers').set(json).send({ fullName: 'Other Guest', phone: '+4511112222' });
  otherCustomerId = other.body.id;
  rentalId = randomUUID();
  await owner.post('/v1/rentals').set(json).send({ id: rentalId, customerId: c.body.id, days: 1, items: [{ assetId: a.body.id }] });
});
afterAll(async () => {
  await app.close();
});

describe('โหมดลูกค้า (ยื่นเครื่องให้ลูกค้าเซ็น)', () => {
  it('เข้าโหมดแล้ว: เห็นเฉพาะสัญญานี้ · หน้าอื่นและลูกค้าคนอื่นถูกปฏิเสธที่เซิร์ฟเวอร์', async () => {
    expect((await owner.post(`/v1/rentals/${rentalId}/customer-mode`).set(nobody)).status).toBe(204);
    expect((await owner.get(`/v1/rentals/${rentalId}`)).status).toBe(200);
    expect((await owner.get(`/v1/media?rentalId=${rentalId}`)).status).toBe(200);
    expect((await owner.get('/v1/auth/me')).body.customerModeRentalId).toBe(rentalId);
    for (const path of ['/v1/customers', `/v1/customers/${otherCustomerId}`, '/v1/bills', '/v1/today', `/v1/media?customerId=${otherCustomerId}`]) {
      const r = await owner.get(path);
      expect(r.status, path).toBe(403);
      expect(r.body.error).toBe('customer_mode');
    }
    expect((await owner.post('/v1/customers').set(json).send({ fullName: 'x' })).status).toBe(403);
  });

  it('รีโหลดหน้าเซ็น = เข้าโหมดสัญญาเดิมซ้ำได้ · สลับไปสัญญาอื่นไม่ได้', async () => {
    expect((await owner.post(`/v1/rentals/${rentalId}/customer-mode`).set(nobody)).status).toBe(204);
    expect((await owner.post(`/v1/rentals/${randomUUID()}/customer-mode`).set(nobody)).status).toBe(403);
  });

  it('รหัสผิดออกจากโหมดไม่ได้ · รหัสถูกกลับมาใช้งานปกติ', async () => {
    expect((await owner.post('/v1/auth/confirm-staff').set(json).send({ password: 'wrong-password' })).status).toBe(401);
    expect((await owner.get('/v1/customers')).status).toBe(403);
    expect((await owner.post('/v1/auth/confirm-staff').set(json).send({ password: 'Owner-island-2026' })).status).toBe(200);
    expect((await owner.get('/v1/customers')).status).toBe(200);
    expect((await owner.get('/v1/auth/me')).body.customerModeRentalId).toBeNull();
  });
});
