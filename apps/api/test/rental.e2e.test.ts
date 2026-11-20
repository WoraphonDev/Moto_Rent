// เฟส 1 ทั้งเส้น: ตั้งของ → ลูกค้า → ปล่อยเช่า → ต่อวัน → รับคืน → ส่วนลด → รับเงิน → หน้าวันนี้
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addStaff, json, nobody, signupShop, startApp, suffix, type Agent } from './helpers.js';

let app: INestApplication;
let owner: Agent;
let staff: Agent;
const s = suffix();
const ids: Record<string, string> = {};
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(async () => {
  app = await startApp();
  owner = await signupShop(app, s);
  staff = await addStaff(app, owner, `staff.${s}`);
});
afterAll(async () => {
  await app.close();
});

describe('ตั้งค่าของให้เช่า', () => {
  it('เจ้าของเพิ่มประเภท Click (รายชิ้น) และชุดดำน้ำ (นับจำนวน)', async () => {
    const click = await owner.post('/v1/asset-types').set(json).send({ name: 'Honda Click 125', tracking: 'unit', codePrefix: 'C-', pricePerDay: 25_000 });
    expect(click.status).toBe(201);
    ids.click = click.body.id;
    const gear = await owner.post('/v1/asset-types').set(json).send({ name: 'ตีนกบ', tracking: 'quantity', pricePerDay: 10_000 });
    ids.gear = gear.body.id;
    const l = await owner.post(`/v1/asset-types/${ids.gear}/variants`).set(json).send({ label: 'L', quantity: 2 });
    expect(l.status).toBe(201);
    ids.finsL = l.body.id;
  });

  it('รหัสรถรันต่อเอง C-01, C-02', async () => {
    const a = await owner.post('/v1/assets').set(json).send({ assetTypeId: ids.click, model: 'Click 125 ขาว', plate: 'กข 1234' });
    const b = await owner.post('/v1/assets').set(json).send({ assetTypeId: ids.click });
    expect([a.body.code, b.body.code]).toEqual(['C-01', 'C-02']);
    ids.c01 = a.body.id;
    ids.c02 = b.body.id;
  });

  it('พนักงานเพิ่มประเภทหรือแก้ราคาไม่ได้', async () => {
    expect((await staff.post('/v1/asset-types').set(json).send({ name: 'x', tracking: 'unit', codePrefix: 'X-', pricePerDay: 1 })).status).toBe(403);
    expect((await staff.patch(`/v1/assets/${ids.c01}`).set(json).send({ pricePerDay: 1 })).status).toBe(403);
  });
});

describe('ปล่อยเช่า', () => {
  it('พนักงานเพิ่มลูกค้าและค้นจากเลขห้องได้', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const c = await staff.post('/v1/customers').set(json).send({ fullName: 'Emma Larsen', nationality: 'DK', hotelRoom: '204', checkoutDate: today, phone: '+4512345678' });
    expect(c.status).toBe(201);
    ids.emma = c.body.id;
    const found = await staff.get('/v1/customers?q=204');
    expect(found.body.map((x: { id: string }) => x.id)).toContain(ids.emma);
  });

  it('Click C-01 3 วัน + ตีนกบ L × 2 → บิลห้อง 204 ฿1,350', async () => {
    ids.r1 = randomUUID();
    // เริ่มเช่าเมื่อ 3 วัน 100 นาทีที่แล้ว → ตอนนี้เลยกำหนด 100 นาที (ใช้ทดสอบค่าคืนช้า)
    const startAt = iso(Date.now() - 3 * 86_400_000 - 100 * 60_000);
    // ย้อนหลังเกิน 24 ชม. ได้เฉพาะเจ้าของ (ลงข้อมูลย้อนหลัง) · พนักงานถูกปฏิเสธ time_out_of_range
    expect((await staff.post('/v1/rentals').set(json).send({ id: ids.r1, customerId: ids.emma, days: 3, startAt, items: [{ assetId: ids.c01 }] })).body.error).toBe('time_out_of_range');
    const r = await owner.post('/v1/rentals').set(json).send({ id: ids.r1, customerId: ids.emma, days: 3, startAt, items: [{ assetId: ids.c01 }, { variantId: ids.finsL, quantity: 2 }] });
    expect(r.status).toBe(201);
    expect(r.body.total).toBe(75_000 + 60_000);
    expect(r.body.items.map((i: { label: string }) => i.label)).toEqual(['Honda Click 125 C-01', 'ตีนกบ L × 2']);
  });

  it('ส่งซ้ำ (เน็ตหลุดแล้วกดอีกที) ไม่เกิดสัญญาหรือรายการซ้อน', async () => {
    const again = await staff.post('/v1/rentals').set(json).send({ id: ids.r1, customerId: ids.emma, days: 3, items: [{ assetId: ids.c01 }] });
    expect(again.body.id).toBe(ids.r1);
    expect(again.body.lines).toHaveLength(2);
  });

  it('รถที่ถูกเช่าอยู่ และตีนกบที่หมด ปล่อยซ้ำไม่ได้', async () => {
    const dup = await staff.post('/v1/rentals').set(json).send({ id: randomUUID(), customerId: ids.emma, days: 1, items: [{ assetId: ids.c01 }] });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('asset_unavailable');
    const fins = await staff.post('/v1/rentals').set(json).send({ id: randomUUID(), customerId: ids.emma, days: 1, items: [{ variantId: ids.finsL, quantity: 1 }] });
    expect(fins.status).toBe(409);
    expect(fins.body).toMatchObject({ error: 'not_enough_stock', available: 0 });
  });

  it('เกินวันเช่าสูงสุดของร้าน (15) ไม่ได้', async () => {
    const r = await staff.post('/v1/rentals').set(json).send({ id: randomUUID(), customerId: ids.emma, days: 16, items: [{ assetId: ids.c02 }] });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'too_many_days', maxDays: 15 });
  });

  it('ลูกค้าที่ติดธง "ไม่ให้เช่า" ปล่อยไม่ได้', async () => {
    const c = await staff.post('/v1/customers').set(json).send({ fullName: 'Bad Driver' });
    expect((await staff.patch(`/v1/customers/${c.body.id}`).set(json).send({ doNotRent: true, doNotRentReason: 'x' })).status).toBe(403);
    await owner.patch(`/v1/customers/${c.body.id}`).set(json).send({ doNotRent: true, doNotRentReason: 'ขับประมาท ทำรถล้ม' });
    const r = await staff.post('/v1/rentals').set(json).send({ id: randomUUID(), customerId: c.body.id, days: 1, items: [{ assetId: ids.c02 }] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'customer_blocked', reason: 'ขับประมาท ทำรถล้ม' });
  });

  it('กระดานรถ: C-01 เลยกำหนด · C-02 ว่าง', async () => {
    const fleet = await staff.get('/v1/assets');
    const state = Object.fromEntries(fleet.body.map((a: { code: string; state: string }) => [a.code, a.state]));
    expect(state).toEqual({ 'C-01': 'overdue', 'C-02': 'available' });
  });
});

describe('ต่อวัน · รับคืน · ยกเลิก', () => {
  it('ต่อ C-02 อีก 2 วัน → วันคืนเลื่อน + เพิ่มรายการต่อวัน', async () => {
    ids.r2 = randomUUID();
    const r = await staff.post('/v1/rentals').set(json).send({ id: ids.r2, customerId: ids.emma, days: 3, items: [{ assetId: ids.c02 }] });
    const ext = await staff.post(`/v1/rentals/${ids.r2}/extend`).set(json).send({ days: 2 });
    expect(ext.status).toBe(200);
    expect(new Date(ext.body.dueAt).getTime() - new Date(r.body.dueAt).getTime()).toBe(2 * 86_400_000);
    expect(ext.body.lines.at(-1)).toMatchObject({ kind: 'extension', amount: 50_000 });
  });

  it('ระบบเสนอค่าคืนช้า: เลย 100 นาที = ครึ่งวันของทุกชิ้น', async () => {
    const p = await staff.get(`/v1/rentals/${ids.r1}/return-preview`);
    expect(p.body.lateMinutes).toBeGreaterThanOrEqual(100);
    expect(p.body.suggestedLateFee).toBe(12_500 + 2 * 5_000);
  });

  it('รับคืน C-01 + ค่าน้ำมัน → รถว่าง ตีนกบกลับเข้าสต็อก', async () => {
    const r = await staff.post(`/v1/rentals/${ids.r1}/return`).set(json).send({ odometer: 12_480, fuel: 6_000 });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('returned');
    expect(r.body.lines.map((l: { kind: string }) => l.kind)).toEqual(['rental', 'gear', 'late_fee', 'fuel']);
    const fleet = await staff.get('/v1/assets');
    expect(fleet.body.find((a: { code: string }) => a.code === 'C-01')).toMatchObject({ state: 'available', odometer: 12_480 });
    const types = await staff.get('/v1/asset-types');
    expect(types.body.find((t: { id: string }) => t.id === ids.gear).variants[0]).toMatchObject({ label: 'L', available: 2 });
  });

  it('รับคืนซ้ำไม่ได้', async () => {
    expect((await staff.post(`/v1/rentals/${ids.r1}/return`).set(json).send({})).status).toBe(409);
  });

  it('พนักงานยกเลิกสัญญาไม่ได้ · เจ้าของยกเลิกได้และยอดในบิลถูกหักคืน', async () => {
    ids.r3 = randomUUID();
    const c = await staff.post('/v1/customers').set(json).send({ fullName: 'Noa Cohen', hotelRoom: '118' });
    await staff.post('/v1/rentals').set(json).send({ id: ids.r3, customerId: c.body.id, days: 1, items: [{ variantId: ids.finsL, quantity: 1 }] });
    expect((await staff.post(`/v1/rentals/${ids.r3}/cancel`).set(json).send({ reason: 'ลูกค้าเปลี่ยนใจ' })).status).toBe(403);
    const r = await owner.post(`/v1/rentals/${ids.r3}/cancel`).set(json).send({ reason: 'ลูกค้าเปลี่ยนใจ' });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(0);
  });
});

describe('บิลและรับเงิน', () => {
  let billId = '';

  it('บิลห้อง 204 รวมทุกสัญญาของ Emma', async () => {
    const open = await staff.get('/v1/bills');
    const bill = open.body.find((b: { customerId: string }) => b.customerId === ids.emma);
    billId = bill.id;
    // r1: 75,000 + 60,000 + ค่าคืนช้า 22,500 + น้ำมัน 6,000 · r2: 75,000 + ต่อ 50,000
    expect(bill.total).toBe(75_000 + 60_000 + 22_500 + 6_000 + 75_000 + 50_000);
  });

  it('พนักงานลดได้ไม่เกิน ฿100 · เกินต้องให้เจ้าของ', async () => {
    const over = await staff.post(`/v1/bills/${billId}/lines`).set(json).send({ kind: 'discount', description: 'ส่วนลด', amount: 15_000, reason: 'ลูกค้าประจำ' });
    expect(over.status).toBe(403);
    expect(over.body.error).toBe('discount_over_limit');
    const noReason = await staff.post(`/v1/bills/${billId}/lines`).set(json).send({ kind: 'discount', description: 'ส่วนลด', amount: 5_000 });
    expect(noReason.status).toBe(400);
    const ok = await staff.post(`/v1/bills/${billId}/lines`).set(json).send({ kind: 'discount', description: 'ส่วนลด', amount: 10_000, reason: 'ลูกค้าประจำ' });
    expect(ok.status).toBe(201);
    expect(ok.body.amount).toBe(-10_000);
  });

  it('รับเงินเกินยอดไม่ได้', async () => {
    const r = await staff.post(`/v1/bills/${billId}/payments`).set(json).send({ payments: [{ method: 'cash', amount: 99_999_999 }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('overpayment');
  });

  it('แยกจ่ายเงินสด + PromptPay ครบยอด → ปิดบิล ออกเลขใบเสร็จ', async () => {
    const bill = await staff.get(`/v1/bills/${billId}`);
    const balance = bill.body.balance as number;
    const r = await staff.post(`/v1/bills/${billId}/payments`).set(json).send({ payments: [{ method: 'cash', amount: 100_000 }, { method: 'promptpay', amount: balance - 100_000 }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'paid', balance: 0 });
    // 0001 เป็นของบิล Noa ที่ปิดเองตอนยกเลิกสัญญา (ยอดเหลือ 0)
    expect(r.body.receiptNo).toMatch(/^RC-\d{4}-0002$/);
  });

  it('บิลที่จ่ายแล้ว: พนักงานยกเลิกไม่ได้ และเพิ่มรายการไม่ได้', async () => {
    expect((await staff.post(`/v1/bills/${billId}/void`).set(json).send({ reason: 'ทดสอบ' })).status).toBe(403);
    const add = await staff.post(`/v1/bills/${billId}/lines`).set(json).send({ kind: 'fuel', description: 'น้ำมัน', amount: 100 });
    expect(add.status).toBe(409);
    expect(add.body.error).toBe('bill_closed');
  });

  it('สัญญาใหม่ของ Emma หลังจ่ายแล้ว เปิดบิลใบใหม่', async () => {
    await staff.post(`/v1/rentals/${ids.r2}/return`).set(json).send({});
    const open = await staff.get('/v1/bills');
    const emmaOpen = open.body.filter((b: { customerId: string }) => b.customerId === ids.emma);
    expect(emmaOpen).toHaveLength(1);
    expect(emmaOpen[0].id).not.toBe(billId);
  });
});

describe('หน้าวันนี้', () => {
  it('เงินเข้าวันนี้แยกตามวิธีจ่าย · เช็คเอาท์วันนี้ที่ยังค้างจ่าย', async () => {
    const t = await staff.get('/v1/today');
    expect(t.status).toBe(200);
    const byMethod = Object.fromEntries(t.body.moneyToday.map((m: { method: string; total: number }) => [m.method, m.total]));
    expect(byMethod.cash).toBe(100_000);
    expect(t.body.overdue).toHaveLength(0);
    // บิลใหม่ของ Emma (ค่าคืนช้าของ C-02 = 0 จึงอาจไม่มียอด) · ถ้ามียอดค้างต้องอยู่ในรายการเช็คเอาท์วันนี้
    for (const u of t.body.unpaidCheckouts) expect(u.balance).toBeGreaterThan(0);
  });

  it('ไม่เข้าระบบดูไม่ได้', async () => {
    const r = await (await import('supertest')).default(app.getHttpServer()).get('/v1/today');
    expect(r.status).toBe(401);
  });

  it('ร้านอื่นมองไม่เห็นสัญญาของร้านนี้', async () => {
    const other = await signupShop(app, suffix());
    expect((await other.get(`/v1/rentals/${ids.r1}`)).status).toBe(404);
    expect((await other.get('/v1/bills')).body).toEqual([]);
    expect((await other.post(`/v1/rentals/${ids.r2}/extend`).set(json).send({ days: 1 })).status).toBe(404);
    expect((await other.post('/v1/auth/logout').set(nobody)).status).toBe(204);
  });
});

describe('สองเครื่องแย่งของนับจำนวนพร้อมกัน', () => {
  it('ตีนกบ L เหลือ 2 คู่ · สองเครื่องขอคนละ 2 คู่พร้อมกัน → สำเร็จเครื่องเดียว', async () => {
    const c = await staff.post('/v1/customers').set(json).send({ fullName: 'Race Test' });
    const send = (agent: Agent) =>
      agent.post('/v1/rentals').set(json).send({ id: randomUUID(), customerId: c.body.id, days: 1, items: [{ variantId: ids.finsL, quantity: 2 }] });
    const results = await Promise.all([send(staff), send(owner)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});

describe('แก้ข้อมูลลูกค้า', () => {
  it('ล้างช่องที่ไม่บังคับได้ (สตริงว่าง = ลบค่าเดิม)', async () => {
    const r = await staff.patch(`/v1/customers/${ids.emma}`).set(json).send({ phone: '', hotelRoom: '205' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ phone: null, hotelRoom: '205' });
  });

  it('สัญญาบอกเลขบิลที่อยู่', async () => {
    const r = await staff.get(`/v1/rentals/${ids.r1}`);
    expect(r.body.billId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
