// รูปหน้าปก · ป๊อปอัปรายละเอียดรถ · สติกเกอร์ QR (canvas หน้า 9–10)
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addStaff, json, nobody, signupShop, startApp, suffix, type Agent } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
const xrw = { 'x-requested-with': 'fetch' };

let app: INestApplication;
let owner: Agent;
let manager: Agent;
let staff: Agent;
let other: Agent;
const s = suffix();
const slug = `shop-${s}`;
const ids: Record<string, string> = {};
const pub = () => request(app.getHttpServer());
const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

/** เชิญผู้จัดการ (helpers.addStaff เชิญเป็นพนักงานเท่านั้น) */
async function addManager(username: string): Promise<Agent> {
  const inv = await owner.post('/v1/invitations').set(json).send({ username, displayName: username, role: 'manager' });
  const token = String(inv.body.url).split('/').pop();
  const m = request.agent(app.getHttpServer());
  await m.post(`/v1/invitations/${token}/accept`).set(json).send({ password: 'Manager-lagoon-88' });
  const login = await m.post('/v1/auth/login').set(json).send({ identifier: username, password: 'Manager-lagoon-88' });
  await owner.post(`/v1/devices/${login.body.deviceId}/approve`).set(json).send({ code: login.body.approvalCode });
  const ok = await m.get('/v1/auth/pending');
  if (ok.body.status !== 'ok') throw new Error(`manager login failed: ${JSON.stringify(ok.body)}`);
  return m;
}

function uploadCover(agent: Agent, target: { assetTypeId?: string; assetId?: string }, file: Buffer = PNG) {
  let r = agent.post('/v1/media').set(xrw).field('kind', 'cover');
  if (target.assetTypeId) r = r.field('assetTypeId', target.assetTypeId);
  if (target.assetId) r = r.field('assetId', target.assetId);
  return r.attach('file', file, 'cover.png');
}

async function assetRow(agent: Agent, id: string) {
  const list = await agent.get('/v1/assets');
  return (list.body as Array<{ id: string; coverMediaId: string | null; ownCover: boolean; qrToken: string }>).find((x) => x.id === id)!;
}

async function confirmBooking(items: Array<{ typeId: string; variantId?: string; quantity: number }>, assetId?: string) {
  const b = await pub()
    .post(`/v1/public/shops/${slug}/bookings`)
    .set(json)
    .send({ fullName: 'Anna Schmidt', whatsapp: '+49 170 1234567', hasLicense: true, pickupAt: hours(48), days: 2, items, startedAt: Date.now() - 10_000, website: '' });
  if (b.status !== 201) throw new Error(`booking failed ${b.status} ${JSON.stringify(b.body)}`);
  const list = await staff.get('/v1/bookings');
  const bk = (list.body as Array<{ id: string; code: string }>).find((x) => x.code === b.body.code)!;
  const d = await staff.get(`/v1/bookings/${bk.id}`);
  const assignments = assetId ? [{ itemId: d.body.items[0].id, assetId }] : [];
  const c = await staff.post(`/v1/bookings/${bk.id}/confirm`).set(json).send({ assignments });
  if (c.status !== 200) throw new Error(`confirm failed ${c.status} ${JSON.stringify(c.body)}`);
  return { id: bk.id, code: b.body.code as string };
}

beforeAll(async () => {
  app = await startApp();
  owner = await signupShop(app, s);
  await owner.patch('/v1/settings').set(json).send({ publicBookingEnabled: true });
  manager = await addManager(`pqman.${s}`);
  staff = await addStaff(app, owner, `pqstaff.${s}`);
  other = await signupShop(app, suffix());
  const click = await owner.post('/v1/asset-types').set(json).send({ name: 'คลิก', publicName: 'Honda Click', tracking: 'unit', codePrefix: 'C-', pricePerDay: 25_000 });
  ids.click = click.body.id;
  ids.c01 = (await owner.post('/v1/assets').set(json).send({ assetTypeId: ids.click, plate: 'กข 1234', odometer: 1000 })).body.id;
  ids.c02 = (await owner.post('/v1/assets').set(json).send({ assetTypeId: ids.click })).body.id;
  const fins = await owner.post('/v1/asset-types').set(json).send({ name: 'ตีนกบ', tracking: 'quantity', pricePerDay: 5_000 });
  ids.fins = fins.body.id;
  ids.finsM = (await owner.post(`/v1/asset-types/${ids.fins}/variants`).set(json).send({ label: 'M', quantity: 5 })).body.id;
  ids.customer = (await staff.post('/v1/customers').set(json).send({ fullName: 'Emma Larsen', hotelRoom: '204' })).body.id;
});
afterAll(async () => {
  await app.close();
});

describe('รูปหน้าปก: อัปโหลด/สิทธิ์', () => {
  it('พนักงานตั้งรูปหน้าปกไม่ได้', async () => {
    const r = await uploadCover(staff, { assetTypeId: ids.click });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
  });

  it('ต้องระบุเป้าหมายอย่างใดอย่างหนึ่ง · ไฟล์ต้องเป็นรูป', async () => {
    expect((await uploadCover(owner, {})).status).toBe(400);
    expect((await uploadCover(owner, { assetTypeId: ids.click, assetId: ids.c01 })).status).toBe(400);
    const bad = await uploadCover(owner, { assetTypeId: ids.click }, Buffer.from('<svg onload=alert(1)>'));
    expect(bad.status).toBe(415);
    expect(bad.body.error).toBe('image_only');
    // vehicle_photo ใส่ assetTypeId ไม่ได้
    const wrong = await staff.post('/v1/media').set(xrw).field('kind', 'maintenance_receipt').field('assetId', ids.c01!).field('assetTypeId', ids.click!).attach('file', PNG, 'x.png');
    expect(wrong.status).toBe(400);
  });

  it('ผู้จัดการตั้งรูปของประเภท → ทุกคันใช้รูปนี้', async () => {
    const r = await uploadCover(manager, { assetTypeId: ids.click });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'cover', assetTypeId: ids.click, assetId: null, contentType: 'image/png', deleteAfter: null });
    ids.typeCover = r.body.id;
    const types = await staff.get('/v1/asset-types');
    expect(types.body.find((t: { id: string }) => t.id === ids.click).coverMediaId).toBe(ids.typeCover);
    expect(types.body.find((t: { id: string }) => t.id === ids.fins).coverMediaId).toBeNull();
    for (const id of [ids.c01!, ids.c02!]) {
      expect(await assetRow(staff, id)).toMatchObject({ coverMediaId: ids.typeCover, ownCover: false });
    }
  });

  it('เจ้าของตั้งรูปเฉพาะคัน → ทับรูปของประเภท', async () => {
    const r = await uploadCover(owner, { assetId: ids.c01 }, JPEG);
    expect(r.status).toBe(201);
    ids.c01Cover = r.body.id;
    const row = await assetRow(staff, ids.c01!);
    expect(row).toMatchObject({ coverMediaId: ids.c01Cover, ownCover: true });
    expect(row.qrToken).toMatch(/^[0-9a-f]{32}$/);
    expect(await assetRow(staff, ids.c02!)).toMatchObject({ coverMediaId: ids.typeCover, ownCover: false });
  });

  it('พนักงานเปิดดูรูปหน้าปกได้', async () => {
    const r = await staff.get(`/v1/media/${ids.c01Cover}/content`).buffer(true);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(r.body as Buffer, JPEG)).toBe(0);
  });

  it('ร้านอื่นตั้งรูปให้ประเภท/คันของร้านนี้ไม่ได้ และเปิดรูปไม่ได้', async () => {
    expect((await uploadCover(other, { assetTypeId: ids.click })).status).toBe(404);
    expect((await uploadCover(other, { assetId: ids.c01 })).status).toBe(404);
    expect((await other.get(`/v1/media/${ids.typeCover}/content`)).status).toBe(404);
  });

  it('เปลี่ยนรูปแล้วรูปเดิมถูกลบตามรอบ (purge) · เอารูปคันออกแล้วกลับไปใช้รูปประเภท', async () => {
    const first = await uploadCover(owner, { assetId: ids.c02 });
    const second = await uploadCover(owner, { assetId: ids.c02 }, JPEG);
    expect(second.status).toBe(201);
    expect(await assetRow(owner, ids.c02!)).toMatchObject({ coverMediaId: second.body.id, ownCover: true });
    // พนักงานเอารูปออกไม่ได้
    const denied = await staff.patch(`/v1/assets/${ids.c02}`).set(json).send({ coverMediaId: null });
    expect(denied.status).toBe(403);
    // ใส่ id รูปเองไม่ได้ (รับเฉพาะ null)
    expect((await owner.patch(`/v1/assets/${ids.c02}`).set(json).send({ coverMediaId: ids.typeCover })).status).toBe(400);
    const rm = await manager.patch(`/v1/assets/${ids.c02}`).set(json).send({ coverMediaId: null });
    expect(rm.status).toBe(200);
    expect(await assetRow(owner, ids.c02!)).toMatchObject({ coverMediaId: ids.typeCover, ownCover: false });
    // รูปเดิมทั้งสองไฟล์ถูกลบเมื่อกดลบทันที · รูปที่ยังใช้อยู่ไม่ถูกลบ
    const p = await owner.post('/v1/media/purge-now').set(nobody);
    expect(p.body.purged).toBeGreaterThanOrEqual(2);
    expect((await staff.get(`/v1/media/${first.body.id}/content`)).status).toBe(404);
    expect((await staff.get(`/v1/media/${second.body.id}/content`)).status).toBe(404);
    expect((await staff.get(`/v1/media/${ids.typeCover}/content`)).status).toBe(200);
    expect((await staff.get(`/v1/media/${ids.c01Cover}/content`)).status).toBe(200);
    const audit = await owner.get('/v1/audit?action=asset.cover_removed');
    expect(audit.body.items.length).toBe(1);
  });

  it('ประเภท: PATCH coverMediaId null เอารูปออก (เจ้าของ/ผู้จัดการ) แล้วตั้งใหม่ได้', async () => {
    const extra = await uploadCover(owner, { assetTypeId: ids.fins });
    expect(extra.status).toBe(201);
    expect((await staff.patch(`/v1/asset-types/${ids.fins}`).set(json).send({ coverMediaId: null })).status).toBe(403);
    const r = await manager.patch(`/v1/asset-types/${ids.fins}`).set(json).send({ coverMediaId: null });
    expect(r.status).toBe(200);
    expect(r.body.coverMediaId).toBeNull();
    const audit = await owner.get('/v1/audit?action=asset_type.cover_set');
    expect(audit.body.items.length).toBe(2);
  });
});

describe('โหมดลูกค้า: เห็นรูปหน้าปกของรถในสัญญานี้เท่านั้น', () => {
  it('ปล่อยเช่า C-01 → รายละเอียดสัญญามี coverMediaId · โหมดลูกค้าเปิดรูปของคัน/ประเภทในสัญญาได้ รูปอื่นไม่ได้', async () => {
    ids.rental = randomUUID();
    const r = await staff.post('/v1/rentals').set(json).send({ id: ids.rental, customerId: ids.customer, days: 1, items: [{ assetId: ids.c01 }] });
    expect(r.status).toBe(201);
    expect(r.body.items[0].coverMediaId).toBe(ids.c01Cover);
    // รูปหน้าปกของคันที่ไม่ได้อยู่ในสัญญา
    const c02Cover = await uploadCover(owner, { assetId: ids.c02 });
    const finsCover = await uploadCover(owner, { assetTypeId: ids.fins });
    ids.finsCover = finsCover.body.id;

    expect((await staff.post(`/v1/rentals/${ids.rental}/customer-mode`).set(nobody)).status).toBe(204);
    const detail = await staff.get(`/v1/rentals/${ids.rental}`);
    expect(detail.body.items[0].coverMediaId).toBe(ids.c01Cover);
    expect((await staff.get(`/v1/media/${ids.c01Cover}/content`)).status).toBe(200);
    expect((await staff.get(`/v1/media/${ids.typeCover}/content`)).status).toBe(200);
    expect((await staff.get(`/v1/media/${c02Cover.body.id}/content`)).status).toBe(404);
    expect((await staff.get(`/v1/media/${ids.finsCover}/content`)).status).toBe(404);
    // หน้ารายละเอียดรถ/กระดานรถถูกปิดในโหมดลูกค้า
    expect((await staff.get(`/v1/assets/${ids.c01}/detail`)).status).toBe(403);
    expect((await staff.post('/v1/auth/confirm-staff').set(json).send({ password: 'Staff-sunrise-77' })).status).toBe(200);
  });
});

describe('หน้าจองสาธารณะ: รูปหน้าปกของประเภท', () => {
  it('ข้อมูลร้านมี coverUrl ต่อประเภท (ไม่มี id ของไฟล์)', async () => {
    const r = await pub().get(`/v1/public/shops/${slug}`);
    expect(r.status).toBe(200);
    const click = r.body.types.find((t: { id: string }) => t.id === ids.click);
    expect(click.hasCover).toBe(true);
    expect(click.coverUrl).toMatch(new RegExp(`^/v1/public/shops/${slug}/types/${ids.click}/cover\\?v=`));
    expect(click.coverMediaId).toBeUndefined();
    ids.coverUrl = click.coverUrl;
  });

  it('ส่งรูปพร้อม cache สาธารณะ 1 ชม. + nosniff', async () => {
    const r = await pub().get(ids.coverUrl!).buffer(true);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['cache-control']).toBe('public, max-age=3600');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(r.body as Buffer, PNG)).toBe(0);
  });

  it('ไม่มีรูป / id ผิด / ประเภทของร้านอื่น → 404', async () => {
    await manager.patch(`/v1/asset-types/${ids.fins}`).set(json).send({ coverMediaId: null });
    expect((await pub().get(`/v1/public/shops/${slug}/types/${ids.fins}/cover`)).status).toBe(404);
    expect((await pub().get(`/v1/public/shops/${slug}/types/not-a-uuid/cover`)).status).toBe(404);
    expect((await pub().get(`/v1/public/shops/${slug}/types/${randomUUID()}/cover`)).status).toBe(404);
    const t = await other.post('/v1/asset-types').set(json).send({ name: 'ATV', tracking: 'unit', codePrefix: 'A-', pricePerDay: 70_000 });
    await uploadCover(other, { assetTypeId: t.body.id });
    expect((await pub().get(`/v1/public/shops/${slug}/types/${t.body.id}/cover`)).status).toBe(404);
    ids.otherType = t.body.id;
  });

  it('ร้านที่ยังไม่เปิดหน้าจอง → 404 · เปิดแล้วได้รูป', async () => {
    const me = await other.get('/v1/auth/me');
    const otherSlug = me.body.org.slug as string;
    expect((await pub().get(`/v1/public/shops/${otherSlug}/types/${ids.otherType}/cover`)).status).toBe(404);
    await other.patch('/v1/settings').set(json).send({ publicBookingEnabled: true });
    expect((await pub().get(`/v1/public/shops/${otherSlug}/types/${ids.otherType}/cover`)).status).toBe(200);
    await other.patch('/v1/settings').set(json).send({ publicBookingEnabled: false });
  });
});

describe('ป๊อปอัปรายละเอียดรถ', () => {
  it('ระหว่างเช่า: สถานะ rented + สัญญาปัจจุบัน + คำขอจองถัดไป', async () => {
    await owner.patch(`/v1/asset-types/${ids.click}/service-interval`).set(json).send({ serviceIntervalKm: 1000 });
    await owner.patch(`/v1/assets/${ids.c01}/service-info`).set(json).send({ nextServiceOdometer: 2000 });
    const bk = await confirmBooking([{ typeId: ids.click!, quantity: 1 }], ids.c01);
    ids.bookingCode = bk.code;
    const r = await staff.get(`/v1/assets/${ids.c01}/detail`);
    expect(r.status).toBe(200);
    expect(r.body.asset).toMatchObject({
      id: ids.c01,
      code: 'C-01',
      typeId: ids.click,
      typeName: 'คลิก',
      publicName: 'Honda Click',
      tracking: 'unit',
      plate: 'กข 1234',
      odometer: 1000,
      status: 'available',
      pricePerDay: 25_000,
      coverMediaId: ids.c01Cover,
      ownCover: true,
    });
    expect(r.body.asset.qrToken).toMatch(/^[0-9a-f]{32}$/);
    expect(r.body.state).toBe('rented');
    expect(r.body.currentRental).toMatchObject({ id: ids.rental, customerName: 'Emma Larsen', room: '204', lateFeeSoFar: 0 });
    expect(r.body.nextBooking).toMatchObject({ code: bk.code, fullName: 'Anna Schmidt' });
    expect(r.body.service).toEqual({ intervalKm: 1000, nextServiceOdometer: 2000, remainingKm: 1000 });
    expect(r.body.lastReturnPhotos).toEqual([]);
    expect(r.body.history).toHaveLength(1);
  });

  it('รับคืนพร้อมรูป + ค่าเสียหาย → รูปตอนรับคืนล่าสุด · ค่าเสียหาย · ประวัติ', async () => {
    for (const slot of ['front', 'back']) {
      const up = await staff.post('/v1/media').set(xrw).field('kind', 'vehicle_photo').field('slot', slot).field('stage', 'return').field('rentalId', ids.rental!).attach('file', JPEG, `${slot}.jpg`);
      expect(up.status).toBe(201);
    }
    // รูปตอนปล่อยไม่นับ
    await staff.post('/v1/media').set(xrw).field('kind', 'vehicle_photo').field('slot', 'left').field('stage', 'checkout').field('rentalId', ids.rental!).attach('file', JPEG, 'l.jpg');
    const ret = await staff.post(`/v1/rentals/${ids.rental}/return`).set(json).send({ odometer: 1250, damage: { amount: 50_000, note: 'กระจกแตก' } });
    expect(ret.status).toBe(200);
    const r = await staff.get(`/v1/assets/${ids.c01}/detail`);
    expect(r.body.state).toBe('available');
    expect(r.body.currentRental).toBeNull();
    expect(r.body.asset.odometer).toBe(1250);
    expect(r.body.service.remainingKm).toBe(750);
    expect(r.body.lastReturnAt).toBeTruthy();
    expect(r.body.lastReturnByName).toBe(`pqstaff.${s}`);
    expect(r.body.lastReturnRentalId).toBe(ids.rental);
    expect(r.body.lastReturnPhotos.map((p: { slot: string }) => p.slot)).toEqual(['front', 'back']);
    expect(r.body.lastReturnPhotos[0]).toMatchObject({ takenByName: `pqstaff.${s}` });
    expect(r.body.lastReturnPhotos[0].mediaId).toBeTruthy();
    expect(r.body.lastReturnPhotos[0].takenAt).toBeTruthy();
    expect(r.body.damage).toHaveLength(1);
    expect(r.body.damage[0]).toMatchObject({ amount: 50_000, rentalId: ids.rental });
    expect(r.body.damage[0].description).toContain('กระจกแตก');
    expect(r.body.history[0]).toMatchObject({ rentalId: ids.rental, customerName: 'Emma Larsen', status: 'returned', lateFee: 0 });
    expect(r.body.history[0].returnedAt).toBeTruthy();
    // รูปที่แสดงในป๊อปอัปเปิดดูได้
    expect((await staff.get(`/v1/media/${r.body.lastReturnPhotos[0].mediaId}/content`)).status).toBe(200);
  });

  it('รถซ่อมอยู่ → maintenance · ร้านอื่นเปิดไม่ได้', async () => {
    await owner.patch(`/v1/assets/${ids.c02}`).set(json).send({ status: 'maintenance' });
    const r = await staff.get(`/v1/assets/${ids.c02}/detail`);
    expect(r.body.state).toBe('maintenance');
    expect(r.body.history).toEqual([]);
    expect(r.body.lastReturnAt).toBeNull();
    expect((await other.get(`/v1/assets/${ids.c01}/detail`)).status).toBe(404);
    await owner.patch(`/v1/assets/${ids.c02}`).set(json).send({ status: 'available' });
  });

  it('ของนับจำนวน: ต่อไซส์ quantity / out / booked / available', async () => {
    const rid = randomUUID();
    const r = await staff.post('/v1/rentals').set(json).send({ id: rid, customerId: ids.customer, days: 1, items: [{ variantId: ids.finsM, quantity: 2 }] });
    expect(r.status).toBe(201);
    await confirmBooking([{ typeId: ids.fins!, variantId: ids.finsM, quantity: 1 }]);
    const d = await staff.get(`/v1/asset-types/${ids.fins}/detail`);
    expect(d.status).toBe(200);
    expect(d.body.type).toMatchObject({ id: ids.fins, name: 'ตีนกบ', tracking: 'quantity', pricePerDay: 5_000, coverMediaId: null });
    expect(d.body.bookedWindowDays).toBe(7);
    expect(d.body.variants).toEqual([{ id: ids.finsM, label: 'M', quantity: 5, out: 2, booked: 1, available: 2 }]);
    expect((await other.get(`/v1/asset-types/${ids.fins}/detail`)).status).toBe(404);
  });
});

describe('สติกเกอร์ QR', () => {
  it('ตั้งช่องทางติดต่อร้าน (เจ้าของเท่านั้น · เก็บเป็นตัวเลขล้วน)', async () => {
    expect((await manager.patch('/v1/settings').set(json).send({ contactWhatsapp: '+66 81 234 5678' })).status).toBe(403);
    const bad = await owner.patch('/v1/settings').set(json).send({ contactPhone: '12-34' });
    expect(bad.status).toBe(400);
    const r = await owner.patch('/v1/settings').set(json).send({ contactWhatsapp: '+66 81 234 5678', contactPhone: '077-123-456' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ contactWhatsapp: '+66812345678', contactPhone: '077123456' });
    const g = await staff.get('/v1/settings');
    expect(g.body.settings).toMatchObject({ contactWhatsapp: '+66812345678', contactPhone: '077123456' });
  });

  it('พนักงานสแกนหาคันได้ · token ของร้านอื่น/รูปแบบผิด → 404', async () => {
    const row = await assetRow(staff, ids.c01!);
    ids.token = row.qrToken;
    const r = await staff.get(`/v1/assets/by-qr/${ids.token}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ assetId: ids.c01, code: 'C-01' });
    const o = await other.get(`/v1/assets/by-qr/${ids.token}`);
    expect(o.status).toBe(404);
    expect(o.body.error).toBe('not_found');
    expect((await staff.get('/v1/assets/by-qr/zzz')).status).toBe(404);
  });

  it('หน้า QR สาธารณะคืนเฉพาะข้อมูลร้าน + รหัสคัน (ไม่มีทะเบียน ลูกค้า สัญญา)', async () => {
    const r = await pub().get(`/v1/public/q/${ids.token}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(
      ['bookingEnabled', 'code', 'contactPhone', 'contactWhatsapp', 'coverUrl', 'hasCover', 'shopName', 'shopSlug', 'typeId', 'typePublicName'].sort(),
    );
    expect(r.body).toMatchObject({
      shopName: `Shop ${s}`,
      shopSlug: slug,
      code: 'C-01',
      typeId: ids.click,
      typePublicName: 'Honda Click',
      contactWhatsapp: '+66812345678',
      contactPhone: '077123456',
      bookingEnabled: true,
      hasCover: true,
    });
    const text = JSON.stringify(r.body);
    for (const secret of ['กข 1234', 'Emma', 'Larsen', ids.rental!, ids.c01!]) expect(text).not.toContain(secret);
    const img = await pub().get(r.body.coverUrl).buffer(true);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['cache-control']).toBe('public, max-age=3600');
    const none = await pub().get('/v1/public/q/0123456789abcdef0123456789abcdef');
    expect(none.status).toBe(404);
    expect(none.body.error).toBe('not_found');
    expect((await pub().get('/v1/public/q/../../etc')).status).toBe(404);
  });

  it('ออก QR ใหม่ (เจ้าของ/ผู้จัดการ) → token เดิมใช้ไม่ได้ทันที', async () => {
    expect((await staff.post(`/v1/assets/${ids.c01}/qr-token/rotate`).set(nobody)).status).toBe(403);
    expect((await other.post(`/v1/assets/${ids.c01}/qr-token/rotate`).set(nobody)).status).toBe(404);
    const r = await manager.post(`/v1/assets/${ids.c01}/qr-token/rotate`).set(nobody);
    expect(r.status).toBe(200);
    expect(r.body.assetId).toBe(ids.c01);
    expect(r.body.code).toBe('C-01');
    expect(r.body.qrToken).toMatch(/^[0-9a-f]{32}$/);
    expect(r.body.qrToken).not.toBe(ids.token);
    expect((await pub().get(`/v1/public/q/${ids.token}`)).status).toBe(404);
    expect((await pub().get(`/v1/public/q/${ids.token}/cover`)).status).toBe(404);
    expect((await staff.get(`/v1/assets/by-qr/${ids.token}`)).status).toBe(404);
    expect((await pub().get(`/v1/public/q/${r.body.qrToken}`)).body.code).toBe('C-01');
    expect((await staff.get(`/v1/assets/by-qr/${r.body.qrToken}`)).body.assetId).toBe(ids.c01);
    const audit = await owner.get('/v1/audit?action=asset.qr_rotated');
    expect(audit.body.items).toHaveLength(1);
    expect(JSON.stringify(audit.body.items[0])).not.toContain(r.body.qrToken);
  });
});
