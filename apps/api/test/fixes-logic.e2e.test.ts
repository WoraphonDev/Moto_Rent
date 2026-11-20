// แก้ bug ตรรกะธุรกิจจากการตรวจ: รับเงินพร้อมกัน · ส่วนลดเกินยอด · เวลาจากเครื่อง · ต่อสัญญาทับคำขอจอง
// ของนับจำนวนกับคำขอจอง · ยืนยันคำขอพร้อมปล่อยเช่า · ปลดระวางรถที่ถูกเช่า · จับคู่เบอร์ลูกค้า
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createDb, withTenant } from '@rental/db';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addStaff, json, signupShop, startApp, suffix, type Agent } from './helpers.js';

let app: INestApplication;
let owner: Agent;
let staff: Agent;
const s = suffix();
const slug = `shop-${s}`;
const ids = {} as Record<'atv' | 'a01' | 'a02' | 'a03' | 'a04' | 'gear' | 'gearL' | 'gearM' | 'cust', string>;
const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const mins = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const pub = () => request(app.getHttpServer());

async function newCustomer(fullName: string, extra: Record<string, unknown> = {}) {
  const c = await staff.post('/v1/customers').set(json).send({ fullName, ...extra });
  if (c.status !== 201) throw new Error(`customer failed ${c.status} ${JSON.stringify(c.body)}`);
  return c.body.id as string;
}

async function rent(agent: Agent, items: unknown[], extra: Record<string, unknown> = {}) {
  return agent.post('/v1/rentals').set(json).send({ id: randomUUID(), customerId: extra.customerId ?? ids.cust, days: 1, items, ...extra });
}

/** ส่งคำขอจองจากหน้าสาธารณะ → คืน id + item แรก */
async function book(over: Record<string, unknown>) {
  const r = await pub()
    .post(`/v1/public/shops/${slug}/bookings`)
    .set(json)
    .send({
      fullName: 'Guest',
      whatsapp: `+49 170 ${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      hasLicense: true,
      pickupAt: hours(48),
      days: 1,
      items: [{ typeId: ids.atv, quantity: 1 }],
      startedAt: Date.now() - 10_000,
      website: '',
      ...over,
    });
  if (r.status !== 201) throw new Error(`booking failed ${r.status} ${JSON.stringify(r.body)}`);
  const list = await staff.get('/v1/bookings');
  const bk = (list.body as Array<{ id: string; code: string }>).find((b) => b.code === r.body.code)!;
  const d = await staff.get(`/v1/bookings/${bk.id}`);
  return { id: bk.id, code: bk.code, itemId: d.body.items[0].id as string };
}

async function auditRows(where: ReturnType<typeof sql>) {
  const me = await owner.get('/v1/auth/me');
  const db = createDb(process.env.DATABASE_APP_URL!, 1);
  try {
    const r = await withTenant(db, { userId: me.body.user.id, orgId: me.body.org.id }, (tx) =>
      tx.execute<{ action: string; risk: string }>(sql`select action, risk from audit_log where ${where}`),
    );
    return r.rows;
  } finally {
    await db.$client.end();
  }
}

beforeAll(async () => {
  app = await startApp();
  owner = await signupShop(app, s);
  await owner.patch('/v1/settings').set(json).send({ publicBookingEnabled: true });
  staff = await addStaff(app, owner, `fxl.${s}`);
  ids.atv = (await owner.post('/v1/asset-types').set(json).send({ name: 'ATV', tracking: 'unit', codePrefix: 'A-', pricePerDay: 70_000 })).body.id;
  for (const k of ['a01', 'a02', 'a03', 'a04'] as const) ids[k] = (await owner.post('/v1/assets').set(json).send({ assetTypeId: ids.atv })).body.id;
  ids.gear = (await owner.post('/v1/asset-types').set(json).send({ name: 'Snorkel', tracking: 'quantity', pricePerDay: 10_000 })).body.id;
  ids.gearL = (await owner.post(`/v1/asset-types/${ids.gear}/variants`).set(json).send({ label: 'L', quantity: 2 })).body.id;
  ids.gearM = (await owner.post(`/v1/asset-types/${ids.gear}/variants`).set(json).send({ label: 'M', quantity: 5 })).body.id;
  ids.cust = await newCustomer('Walk In');
});
afterAll(async () => {
  await app.close();
});

describe('บิล: รับเงินพร้อมกัน · ส่วนลด', () => {
  it('สองเครื่องรับเงินบางส่วนพร้อมกัน → ไม่รับเกินยอด · ครบแล้วปิดบิล', async () => {
    const c = await newCustomer('Pay Race');
    const r = await rent(staff, [{ variantId: ids.gearM, quantity: 1 }], { customerId: c });
    expect(r.status).toBe(201);
    const billId = r.body.billId as string;
    const pay = (amount: number) => staff.post(`/v1/bills/${billId}/payments`).set(json).send({ payments: [{ method: 'cash', amount, clientId: randomUUID() }] });
    const [p1, p2] = await Promise.all([pay(6_000), pay(6_000)]);
    expect([p1.status, p2.status].sort()).toEqual([200, 400]);
    expect([p1, p2].find((x) => x.status === 400)!.body.error).toBe('overpayment');
    const mid = await staff.get(`/v1/bills/${billId}`);
    expect(mid.body).toMatchObject({ status: 'open', paid: 6_000, balance: 4_000 });
    // สองเครื่องจ่ายส่วนที่เหลือพร้อมกัน → ผ่านเครื่องเดียว บิลปิดพร้อมใบเสร็จ
    const [q1, q2] = await Promise.all([pay(4_000), pay(4_000)]);
    const qs = [q1, q2].sort((x, y) => x.status - y.status);
    expect(qs[0]!.status).toBe(200);
    // เครื่องที่ช้ากว่าเห็นบิลปิดแล้ว (bill_closed) หรือยอดเหลือ 0 (overpayment)
    expect(['bill_closed', 'overpayment']).toContain(qs[1]!.body.error);
    const done = await staff.get(`/v1/bills/${billId}`);
    expect(done.body).toMatchObject({ status: 'paid', paid: 10_000, balance: 0 });
    expect(done.body.receiptNo).toMatch(/^RC-\d{4}-\d{4}$/);
  });

  it('ส่วนลดเกินยอดคงค้างไม่ได้ · ลดเท่ายอดพอดี = ปิดบิล', async () => {
    const c = await newCustomer('Discount');
    const r = await rent(staff, [{ variantId: ids.gearM, quantity: 1 }], { customerId: c });
    const billId = r.body.billId as string;
    await staff.post(`/v1/bills/${billId}/payments`).set(json).send({ payments: [{ method: 'cash', amount: 4_000 }] });
    const over = await owner.post(`/v1/bills/${billId}/lines`).set(json).send({ kind: 'discount', description: 'ส่วนลด', amount: 6_001, reason: 'ทดสอบ' });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ error: 'discount_exceeds_balance', balance: 6_000 });
    const exact = await owner.post(`/v1/bills/${billId}/lines`).set(json).send({ kind: 'discount', description: 'ส่วนลด', amount: 6_000, reason: 'ทดสอบ' });
    expect(exact.status).toBe(201);
    const b = await staff.get(`/v1/bills/${billId}`);
    expect(b.body).toMatchObject({ status: 'paid', balance: 0 });
    expect(b.body.receiptNo).toMatch(/^RC-/);
  });

  it('ยกเลิกสัญญาหลังจ่ายแล้ว → บิลเปิดค้าง แสดงยอดต้องคืนเงิน', async () => {
    const c = await newCustomer('Refund');
    const r = await rent(staff, [{ variantId: ids.gearM, quantity: 1 }], { customerId: c });
    const billId = r.body.billId as string;
    await staff.post(`/v1/bills/${billId}/payments`).set(json).send({ payments: [{ method: 'cash', amount: 3_000 }] });
    expect((await owner.post(`/v1/rentals/${r.body.id}/cancel`).set(json).send({ reason: 'ลูกค้าเปลี่ยนใจ' })).status).toBe(200);
    const b = await staff.get(`/v1/bills/${billId}`);
    expect(b.body).toMatchObject({ status: 'open', balance: -3_000, refundDue: 3_000 });
  });
});

describe('เวลาจากเครื่อง (ปล่อยเช่า/รับคืน)', () => {
  it('ย้อนหลังเกิน 24 ชม. หรือล่วงหน้าเกิน 5 นาที ถูกปฏิเสธ (พนักงาน)', async () => {
    const past = await rent(staff, [{ variantId: ids.gearM, quantity: 1 }], { startAt: hours(-25) });
    expect(past.status).toBe(400);
    expect(past.body.error).toBe('time_out_of_range');
    const future = await rent(staff, [{ variantId: ids.gearM, quantity: 1 }], { startAt: mins(10) });
    expect(future.body.error).toBe('time_out_of_range');
  });

  it('ย้อนหลัง 30 นาที ได้ แต่บันทึกเป็นรายการเสี่ยง · รับคืนเวลาอนาคตไม่ได้', async () => {
    const r = await rent(staff, [{ variantId: ids.gearM, quantity: 1 }], { startAt: mins(-30) });
    expect(r.status).toBe(201);
    const rows = await auditRows(sql`entity_id = ${r.body.id} and action = 'rental.created'`);
    expect(rows[0]?.risk).toBe('risky');
    const now = await rent(staff, [{ variantId: ids.gearM, quantity: 1 }], { startAt: new Date().toISOString() });
    expect((await auditRows(sql`entity_id = ${now.body.id} and action = 'rental.created'`))[0]?.risk).toBe('normal');
    const bad = await staff.post(`/v1/rentals/${r.body.id}/return`).set(json).send({ returnedAt: mins(30) });
    expect(bad.body.error).toBe('time_out_of_range');
    const ok = await staff.post(`/v1/rentals/${r.body.id}/return`).set(json).send({ returnedAt: new Date().toISOString() });
    expect(ok.status).toBe(200);
  });
});

describe('ต่อสัญญา / ของนับจำนวน กับคำขอจอง', () => {
  it('ต่อสัญญาทับช่วงที่คำขอจองยืนยันรถคันนั้นไว้ไม่ได้', async () => {
    const r = await rent(staff, [{ assetId: ids.a01 }]);
    expect(r.status).toBe(201);
    const bk = await book({ pickupAt: hours(72), days: 2 });
    const conf = await staff.post(`/v1/bookings/${bk.id}/confirm`).set(json).send({ assignments: [{ itemId: bk.itemId, assetId: ids.a01 }] });
    expect(conf.status).toBe(200);
    const ext = await staff.post(`/v1/rentals/${r.body.id}/extend`).set(json).send({ days: 3 });
    expect(ext.status).toBe(409);
    expect(ext.body).toMatchObject({ error: 'asset_reserved', bookingCode: bk.code });
    // ต่อแค่ไม่ถึงวันรับรถของคำขอ ได้
    expect((await staff.post(`/v1/rentals/${r.body.id}/extend`).set(json).send({ days: 1 })).status).toBe(200);
  });

  it('ของนับจำนวนที่คำขอจองกันไว้ ปล่อยให้คนอื่นไม่ได้ · ลดสต็อกต่ำกว่าที่จองไว้ไม่ได้', async () => {
    const bk = await book({ pickupAt: hours(12), days: 2, items: [{ typeId: ids.gear, variantId: ids.gearL, quantity: 2 }] });
    expect((await staff.post(`/v1/bookings/${bk.id}/confirm`).set(json).send({ assignments: [] })).status).toBe(200);
    const other = await rent(staff, [{ variantId: ids.gearL, quantity: 1 }]);
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('not_enough_stock');
    const adj = await owner.post(`/v1/asset-variants/${ids.gearL}/adjust`).set(json).send({ delta: -1, reason: 'ชำรุด' });
    expect(adj.status).toBe(409);
    expect(adj.body).toMatchObject({ error: 'stock_below_out', booked: 2 });
    // ลูกค้าของคำขอเองมารับ → ไม่ถูกคำขอตัวเองกัน
    const d = await staff.get(`/v1/bookings/${bk.id}`);
    const pick = await rent(staff, [{ variantId: ids.gearL, quantity: 2 }], { customerId: d.body.customerId, bookingId: bk.id, days: 2, channel: 'booking_page' });
    expect(pick.status).toBe(201);
  });
});

describe('ล็อกรถพร้อมกัน', () => {
  it('ยืนยันคำขอจองกับปล่อยเช่ารถคันเดียวกันพร้อมกัน → สำเร็จอย่างเดียว ไม่ deadlock', async () => {
    const bk = await book({ pickupAt: hours(1), days: 1 });
    const [conf, out] = await Promise.all([
      staff.post(`/v1/bookings/${bk.id}/confirm`).set(json).send({ assignments: [{ itemId: bk.itemId, assetId: ids.a02 }] }),
      rent(staff, [{ assetId: ids.a02 }]),
    ]);
    const ok = [conf.status === 200, out.status === 201].filter(Boolean);
    expect(ok).toHaveLength(1);
    const loser = conf.status === 200 ? out : conf;
    expect(loser.status).toBe(409);
    expect(['asset_reserved', 'asset_rented', 'asset_unavailable']).toContain(loser.body.error);
  });
});

describe('สถานะรถ', () => {
  it('รถที่ถูกเช่าอยู่ ปลดระวาง/ส่งซ่อมไม่ได้', async () => {
    const r = await rent(staff, [{ assetId: ids.a04 }]);
    expect(r.status).toBe(201);
    for (const status of ['retired', 'maintenance']) {
      const p = await owner.patch(`/v1/assets/${ids.a04}`).set(json).send({ status });
      expect(p.status).toBe(409);
      expect(p.body.error).toBe('asset_in_use');
    }
    expect((await owner.patch(`/v1/assets/${ids.a04}`).set(json).send({ odometer: 100 })).status).toBe(200);
  });

  it('รถที่มีคำขอจองยืนยันไว้ ปลดระวางไม่ได้', async () => {
    const bk = await book({ pickupAt: hours(100), days: 1 });
    expect((await staff.post(`/v1/bookings/${bk.id}/confirm`).set(json).send({ assignments: [{ itemId: bk.itemId, assetId: ids.a03 }] })).status).toBe(200);
    const p = await owner.patch(`/v1/assets/${ids.a03}`).set(json).send({ status: 'retired' });
    expect(p.status).toBe(409);
    expect(p.body).toMatchObject({ error: 'asset_booked', bookingCode: bk.code });
  });
});

describe('จับคู่ลูกค้าจากเบอร์ในคำขอจอง', () => {
  it('+66 กับ 0 นำหน้าเป็นคนเดียวกัน · ไม่ทับห้อง/วันออกของลูกค้าเดิม · เบอร์ต่างกันสร้างใหม่', async () => {
    const existing = await newCustomer('Somchai', { phone: '+66 81 234 5678', hotelRoom: '101' });
    const same = await book({ whatsapp: '081 234 5678', hotelRoom: '999', fullName: 'Someone Else', pickupAt: hours(300), items: [{ typeId: ids.gear, variantId: ids.gearM, quantity: 1 }] });
    expect((await staff.post(`/v1/bookings/${same.id}/confirm`).set(json).send({ assignments: [] })).status).toBe(200);
    expect((await staff.get(`/v1/bookings/${same.id}`)).body.customerId).toBe(existing);
    const c = await staff.get(`/v1/customers/${existing}`);
    expect(c.body.hotelRoom ?? c.body.customer?.hotelRoom).toBe('101');

    const diff = await book({ whatsapp: '+66 82 234 5678', pickupAt: hours(300), items: [{ typeId: ids.gear, variantId: ids.gearM, quantity: 1 }] });
    expect((await staff.post(`/v1/bookings/${diff.id}/confirm`).set(json).send({ assignments: [] })).status).toBe(200);
    expect((await staff.get(`/v1/bookings/${diff.id}`)).body.customerId).not.toBe(existing);
  });
});
