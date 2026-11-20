// เฟส 1 ส่วนที่เหลือ: รูป/เอกสาร · ลายเซ็นลูกค้า · ปิดยอดสิ้นวัน · ลบเอกสารตามกำหนด · รับเงินซ้ำจากโหมดออฟไลน์
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createDb, withTenant } from '@rental/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addStaff, json, nobody, signupShop, startApp, suffix, type Agent } from './helpers.js';

// PNG 1×1 ที่ถูกต้อง + JPEG ขนาดเล็ก (magic bytes ถูกต้อง)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);

let app: INestApplication;
let owner: Agent;
let staff: Agent;
const ids: Record<string, string> = {};
const xrw = { 'x-requested-with': 'fetch' };

async function setupRental(agent: Agent) {
  const c = await agent.post('/v1/customers').set(json).send({ fullName: 'Emma Larsen', hotelRoom: '204' });
  const id = randomUUID();
  const r = await agent.post('/v1/rentals').set(json).send({ id, customerId: c.body.id, days: 2, items: [{ assetId: ids.c01 }] });
  expect(r.status).toBe(201);
  return { customerId: c.body.id as string, rentalId: id, billId: r.body.billId as string };
}

beforeAll(async () => {
  app = await startApp();
  owner = await signupShop(app, suffix());
  staff = await addStaff(app, owner, `p1staff.${suffix()}`);
  const t = await owner.post('/v1/asset-types').set(json).send({ name: 'Click', tracking: 'unit', codePrefix: 'C-', pricePerDay: 25_000 });
  ids.c01 = (await owner.post('/v1/assets').set(json).send({ assetTypeId: t.body.id })).body.id;
  Object.assign(ids, await setupRental(staff));
});
afterAll(async () => {
  await app.close();
});

describe('รูปรถและเอกสาร', () => {
  it('ไม่มี header กัน CSRF → ปฏิเสธการอัปโหลด', async () => {
    const r = await staff.post('/v1/media').field('kind', 'vehicle_photo').attach('file', JPEG, 'a.jpg');
    expect(r.status).toBe(403);
  });

  it('ไฟล์ที่ไม่ใช่รูป (แม้ตั้งชื่อ .jpg) ถูกปฏิเสธ', async () => {
    const r = await staff
      .post('/v1/media')
      .set(xrw)
      .field('kind', 'vehicle_photo')
      .field('slot', 'front')
      .field('stage', 'checkout')
      .field('rentalId', ids.rentalId!)
      .attach('file', Buffer.from('<svg onload=alert(1)>'), { filename: 'evil.jpg', contentType: 'image/jpeg' });
    expect(r.status).toBe(415);
    expect(r.body.error).toBe('image_only');
  });

  it('รูปรถต้องระบุสัญญา มุม และช่วง', async () => {
    const r = await staff.post('/v1/media').set(xrw).field('kind', 'vehicle_photo').attach('file', JPEG, 'a.jpg');
    expect(r.status).toBe(400);
  });

  it('อัปโหลดรูปรถตอนปล่อย แล้วเปิดดูได้ (ชนิดไฟล์ + no-store)', async () => {
    const up = await staff
      .post('/v1/media')
      .set(xrw)
      .field('kind', 'vehicle_photo')
      .field('slot', 'front')
      .field('stage', 'checkout')
      .field('rentalId', ids.rentalId!)
      .attach('file', JPEG, 'front.jpg');
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ kind: 'vehicle_photo', slot: 'front', stage: 'checkout', contentType: 'image/jpeg', deleteAfter: null });
    ids.photo = up.body.id;
    const list = await staff.get(`/v1/media?rentalId=${ids.rentalId}`);
    expect(list.body.map((m: { id: string }) => m.id)).toContain(ids.photo);
    const content = await staff.get(`/v1/media/${ids.photo}/content`).buffer(true);
    expect(content.status).toBe(200);
    expect(content.headers['content-type']).toBe('image/jpeg');
    expect(content.headers['cache-control']).toBe('private, no-store');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(content.body as Buffer, JPEG)).toBe(0);
  });

  it('เอกสารลูกค้า: มีกำหนดลบอัตโนมัติ และการเปิดดูทุกครั้งเข้าประวัติ', async () => {
    const up = await staff.post('/v1/media').set(xrw).field('kind', 'document').field('slot', 'passport').field('customerId', ids.customerId!).attach('file', PNG, 'passport.png');
    expect(up.status).toBe(201);
    const days = (new Date(up.body.deleteAfter).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
    ids.doc = up.body.id;
    expect((await staff.get(`/v1/media/${ids.doc}/content`)).status).toBe(200);
    expect((await staff.get(`/v1/media/${ids.doc}/content`)).status).toBe(200);
    // ประวัติอ่านได้เฉพาะเจ้าของ/ผู้จัดการ · ตรวจผ่านฐานข้อมูลในนามเจ้าของ
    const me = await owner.get('/v1/auth/me');
    const db = createDb(process.env.DATABASE_APP_URL!, 1);
    const views = await withTenant(db, { userId: me.body.user.id, orgId: me.body.org.id }, (tx) =>
      tx.execute(sql`select id from audit_log where action = 'document.viewed' and entity_id = ${ids.doc}`),
    );
    await db.$client.end();
    expect(views.rows).toHaveLength(2);
  });

  it('ร้านอื่นเห็นหรือเปิดไฟล์ไม่ได้ และแนบรูปกับสัญญาของร้านนี้ไม่ได้', async () => {
    const other = await signupShop(app, suffix());
    expect((await other.get(`/v1/media/${ids.photo}/content`)).status).toBe(404);
    expect((await other.get(`/v1/media?rentalId=${ids.rentalId}`)).body).toEqual([]);
    const r = await other
      .post('/v1/media')
      .set(xrw)
      .field('kind', 'vehicle_photo')
      .field('slot', 'back')
      .field('stage', 'checkout')
      .field('rentalId', ids.rentalId!)
      .attach('file', JPEG, 'x.jpg');
    expect(r.status).toBe(404);
  });
});

describe('ลูกค้าเซ็นสัญญา', () => {
  it('ต้องติ๊กยอมรับ และลายเซ็นต้องเป็น PNG', async () => {
    const noAccept = await staff.post(`/v1/rentals/${ids.rentalId}/sign`).set(xrw).field('signerName', 'Emma Larsen').attach('signature', PNG, 'sig.png');
    expect(noAccept.status).toBe(400);
    const jpeg = await staff.post(`/v1/rentals/${ids.rentalId}/sign`).set(xrw).field('signerName', 'Emma Larsen').field('accepted', 'true').attach('signature', JPEG, 'sig.jpg');
    expect(jpeg.status).toBe(415);
  });

  it('เซ็นแล้วบันทึกเวลา + ชื่อ · เซ็นซ้ำไม่ได้', async () => {
    const r = await staff.post(`/v1/rentals/${ids.rentalId}/sign`).set(xrw).field('signerName', 'Emma Larsen').field('accepted', 'true').attach('signature', PNG, 'sig.png');
    expect(r.status).toBe(200);
    expect(r.body.signerName).toBe('Emma Larsen');
    const again = await staff.post(`/v1/rentals/${ids.rentalId}/sign`).set(xrw).field('signerName', 'Emma Larsen').field('accepted', 'true').attach('signature', PNG, 'sig.png');
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_signed');
  });

  it('ออกจากหน้าลูกค้า: รหัสผิดไม่ผ่าน · รหัสถูกผ่าน', async () => {
    const bad = await staff.post('/v1/auth/confirm-staff').set(json).send({ password: 'not-my-password' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('wrong_password');
    const ok = await staff.post('/v1/auth/confirm-staff').set(json).send({ password: 'Staff-sunrise-77' });
    expect(ok.status).toBe(200);
  });
});

describe('รับเงินซ้ำจากโหมดออฟไลน์', () => {
  it('clientId เดิมส่งซ้ำ → ไม่รับเงินซ้ำ', async () => {
    const pay = { payments: [{ method: 'cash', amount: 10_000, clientId: randomUUID() }] };
    const a = await staff.post(`/v1/bills/${ids.billId}/payments`).set(json).send(pay);
    expect(a.status).toBe(200);
    const b = await staff.post(`/v1/bills/${ids.billId}/payments`).set(json).send(pay);
    expect(b.status).toBe(200);
    expect(b.body.payments).toHaveLength(1);
    expect(b.body.paid).toBe(10_000);
  });
});

describe('รับคืนแล้วเลื่อนกำหนดลบเอกสาร', () => {
  it('กำหนดลบ = วันคืน + จำนวนวันที่ร้านตั้ง', async () => {
    const r = await staff.post(`/v1/rentals/${ids.rentalId}/return`).set(json).send({});
    expect(r.status).toBe(200);
    const list = await staff.get(`/v1/media?customerId=${ids.customerId}`);
    const doc = list.body.find((m: { id: string }) => m.id === ids.doc);
    const fromReturn = (new Date(doc.deleteAfter).getTime() - new Date(r.body.returnedAt).getTime()) / 86_400_000;
    expect(fromReturn).toBeCloseTo(90, 3);
  });
});

describe('ปิดยอดสิ้นวัน', () => {
  it('ยอดเงินสดที่คาด = เงินสดที่รับวันนี้ · ปิดซ้ำไม่ได้', async () => {
    const s = await staff.get('/v1/day-close');
    expect(s.status).toBe(200);
    expect(s.body.expectedCash).toBe(10_000);
    expect(s.body.closed).toBeNull();
    const close = await staff.post('/v1/day-close').set(json).send({ date: s.body.date, countedCash: 9_500, note: 'ทอนผิด' });
    expect(close.status).toBe(201);
    expect(close.body).toMatchObject({ expectedCash: 10_000, countedCash: 9_500, difference: -500 });
    const dup = await staff.post('/v1/day-close').set(json).send({ date: s.body.date, countedCash: 10_000 });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('day_already_closed');
    const after = await staff.get(`/v1/day-close?date=${s.body.date}`);
    expect(after.body.closed).toMatchObject({ difference: -500 });
  });

  it('ปิดวันในอนาคตไม่ได้', async () => {
    const r = await staff.post('/v1/day-close').set(json).send({ date: '2099-01-01', countedCash: 0 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('future_date');
  });

  it('ปิดยอดแล้วรับเงินเพิ่มในวันนั้นไม่ได้', async () => {
    // เดิม: จ่ายได้แต่ยกเลิกบิลไม่ได้ · ตอนนี้ฐานข้อมูลกันรับเงินในวันที่ปิดยอดแล้วตั้งแต่แรก (migration 0009)
    const { billId } = await setupRental(owner);
    const bill = await owner.get(`/v1/bills/${billId}`);
    const p = await owner.post(`/v1/bills/${billId}/payments`).set(json).send({ payments: [{ method: 'promptpay', amount: bill.body.balance }] });
    expect(p.status).toBe(409);
    expect(p.body.error).toBe('day_closed');
    const after = await owner.get(`/v1/bills/${billId}`);
    expect(after.body).toMatchObject({ status: 'open', paid: 0 });
  });
});

describe('ลบเอกสารที่ครบกำหนด (PDPA)', () => {
  it('เอกสารที่เลยกำหนดถูกลบทั้งไฟล์และรายการ · รูปรถไม่ถูกลบ', async () => {
    const up = await staff.post('/v1/media').set(xrw).field('kind', 'document').field('slot', 'license').field('customerId', ids.customerId!).attach('file', PNG, 'license.png');
    const docId = up.body.id as string;
    const me = await owner.get('/v1/auth/me');
    const db = createDb(process.env.DATABASE_APP_URL!, 1);
    await withTenant(db, { userId: me.body.user.id, orgId: me.body.org.id }, (tx) =>
      tx.execute(sql`update media set delete_after = now() - interval '1 minute' where id = ${docId}`),
    );
    await db.$client.end();
    expect((await staff.post('/v1/media/purge-now').set(nobody)).status).toBe(403);
    const p = await owner.post('/v1/media/purge-now').set(nobody);
    expect(p.status).toBe(200);
    expect(p.body.purged).toBeGreaterThanOrEqual(1);
    expect((await staff.get(`/v1/media/${docId}/content`)).status).toBe(404);
    expect((await staff.get(`/v1/media/${ids.photo}/content`)).status).toBe(200);
  });
});
