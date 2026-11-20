// เฟส 2: ซ่อมบำรุง · ปรับสต็อก · ตั้งค่าร้าน · เพดานส่วนลดรายคน · ประวัติการใช้งาน · รายงาน
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addStaff, json, signupShop, startApp, suffix, type Agent } from './helpers.js';

let app: INestApplication;
let owner: Agent;
let staff: Agent;
const s = suffix();
const ids: Record<string, string> = {};
let today = '';
let staffId = '';

const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

beforeAll(async () => {
  app = await startApp();
  owner = await signupShop(app, s);
  staff = await addStaff(app, owner, `p2s.${s}`);
  today = (await owner.get('/v1/today')).body.date;
  const me = await staff.get('/v1/auth/me');
  staffId = me.body.user.id;

  const click = await owner.post('/v1/asset-types').set(json).send({ name: 'Click', tracking: 'unit', codePrefix: 'C-', pricePerDay: 25_000 });
  ids.click = click.body.id;
  for (const odo of [5_000, 5_200, 8_000]) {
    const a = await owner.post('/v1/assets').set(json).send({ assetTypeId: ids.click, odometer: odo });
    ids[a.body.code] = a.body.id;
  }
  const fins = await owner.post('/v1/asset-types').set(json).send({ name: 'ตีนกบ', tracking: 'quantity', pricePerDay: 10_000 });
  ids.fins = fins.body.id;
  ids.finsL = (await owner.post(`/v1/asset-types/${ids.fins}/variants`).set(json).send({ label: 'L', quantity: 2 })).body.id;
  ids.cust = (await staff.post('/v1/customers').set(json).send({ fullName: 'Report Test', hotelRoom: '204' })).body.id;
});
afterAll(async () => {
  await app.close();
});

describe('ซ่อมบำรุง', () => {
  it('ตั้งรอบน้ำมันเครื่องและวันหมดเอกสาร (เจ้าของเท่านั้น)', async () => {
    expect((await owner.patch(`/v1/asset-types/${ids.click}/service-interval`).set(json).send({ serviceIntervalKm: 1_000 })).status).toBe(200);
    await owner.patch(`/v1/assets/${ids['C-01']}/service-info`).set(json).send({ nextServiceOdometer: 5_000, insuranceExpiresOn: addDays(today, 10), taxExpiresOn: addDays(today, -1) });
    await owner.patch(`/v1/assets/${ids['C-02']}/service-info`).set(json).send({ nextServiceOdometer: 5_400, insuranceExpiresOn: addDays(today, 200) });
    expect((await staff.patch(`/v1/assets/${ids['C-01']}/service-info`).set(json).send({ nextServiceOdometer: 1 })).status).toBe(403);
  });

  it('รายการถึงกำหนด: เลยรอบน้ำมัน/ภาษีหมด = แดง · ใกล้ = ส้ม · คันด่วนสุดขึ้นก่อน', async () => {
    const r = await staff.get('/v1/maintenance/due');
    expect(r.status).toBe(200);
    const byCode = Object.fromEntries(r.body.assets.map((x: { code: string }) => [x.code, x]));
    expect(r.body.assets[0].code).toBe('C-01');
    expect(byCode['C-01'].urgency).toBe('overdue');
    const c1 = Object.fromEntries(byCode['C-01'].items.map((i: { kind: string }) => [i.kind, i]));
    expect(c1.oil).toMatchObject({ urgency: 'overdue', remaining: 0 });
    expect(c1.insurance).toMatchObject({ urgency: 'soon', remaining: 10 });
    expect(c1.tax).toMatchObject({ urgency: 'overdue', remaining: -1 });
    expect(byCode['C-02']).toMatchObject({ urgency: 'soon' });
    expect(byCode['C-02'].items.find((i: { kind: string }) => i.kind === 'oil')).toMatchObject({ remaining: 200 });
    expect(byCode['C-03']).toMatchObject({ urgency: 'ok', items: [] });
  });

  it('บันทึกเปลี่ยนน้ำมันเครื่อง → รอบถัดไป = ไมล์ตอนเปลี่ยน + 1,000 กม.', async () => {
    const r = await staff.post('/v1/maintenance').set(json).send({ assetId: ids['C-01'], kind: 'oil', description: 'เปลี่ยนน้ำมันเครื่อง', cost: 35_000, odometer: 5_100, performedOn: today });
    expect(r.status).toBe(201);
    expect(r.body.assetUpdate).toMatchObject({ odometer: 5_100, nextServiceOdometer: 6_100 });
    const due = await staff.get('/v1/maintenance/due');
    const c1 = due.body.assets.find((x: { code: string }) => x.code === 'C-01');
    expect(c1.items.find((i: { kind: string }) => i.kind === 'oil')).toMatchObject({ urgency: 'ok', remaining: 1_000 });
  });

  it('ต่อภาษีแล้วใส่วันหมดใหม่ → ไม่เลยกำหนดแล้ว', async () => {
    await staff.post('/v1/maintenance').set(json).send({ assetId: ids['C-01'], kind: 'tax', description: 'ต่อภาษี', cost: 0, performedOn: today, newExpiry: addDays(today, 365) });
    const due = await staff.get('/v1/maintenance/due');
    const c1 = due.body.assets.find((x: { code: string }) => x.code === 'C-01');
    expect(c1.items.find((i: { kind: string }) => i.kind === 'tax').urgency).toBe('ok');
    const hist = await staff.get(`/v1/maintenance?assetId=${ids['C-01']}`);
    expect(hist.body.map((h: { kind: string }) => h.kind).sort()).toEqual(['oil', 'tax']);
  });
});

describe('ปรับสต็อก', () => {
  it('ลดสต็อกต่ำกว่าของที่ออกไปไม่ได้ · ซื้อเพิ่มได้ · มีประวัติ', async () => {
    ids.finsRental = randomUUID();
    const rent = await staff.post('/v1/rentals').set(json).send({ id: ids.finsRental, customerId: ids.cust, days: 1, items: [{ variantId: ids.finsL, quantity: 2 }] });
    expect(rent.status).toBe(201);
    const below = await owner.post(`/v1/asset-variants/${ids.finsL}/adjust`).set(json).send({ delta: -1, reason: 'ชำรุด' });
    expect(below.status).toBe(409);
    expect(below.body).toMatchObject({ error: 'stock_below_out', out: 2, quantity: 2 });
    const up = await owner.post(`/v1/asset-variants/${ids.finsL}/adjust`).set(json).send({ delta: 3, reason: 'ซื้อเพิ่ม' });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ quantity: 5, out: 2, available: 3 });
    const hist = await staff.get(`/v1/asset-variants/${ids.finsL}/adjustments`);
    expect(hist.body).toHaveLength(1);
    expect(hist.body[0]).toMatchObject({ delta: 3, reason: 'ซื้อเพิ่ม' });
  });

  it('พนักงานปรับสต็อกไม่ได้ · ต้องมีเหตุผล', async () => {
    expect((await staff.post(`/v1/asset-variants/${ids.finsL}/adjust`).set(json).send({ delta: 1, reason: 'ซื้อเพิ่ม' })).status).toBe(403);
    expect((await owner.post(`/v1/asset-variants/${ids.finsL}/adjust`).set(json).send({ delta: 1 })).status).toBe(400);
  });
});

describe('ตั้งค่าร้าน', () => {
  it('พนักงานแก้กฎไม่ได้', async () => {
    expect((await staff.patch('/v1/settings').set(json).send({ maxRentalDays: 99 })).status).toBe(403);
    expect((await staff.patch('/v1/orgs/current').set(json).send({ name: 'x' })).status).toBe(403);
  });

  it('เจ้าของลดวันเช่าสูงสุดเหลือ 3 → ปล่อยเช่า 4 วันไม่ได้', async () => {
    const r = await owner.patch('/v1/settings').set(json).send({ maxRentalDays: 3 });
    expect(r.status).toBe(200);
    const co = await staff.post('/v1/rentals').set(json).send({ id: randomUUID(), customerId: ids.cust, days: 4, items: [{ assetId: ids['C-02'] }] });
    expect(co.status).toBe(400);
    expect(co.body).toMatchObject({ error: 'too_many_days', maxDays: 3 });
    await owner.patch('/v1/settings').set(json).send({ maxRentalDays: 15 });
  });

  it('ช่วงครึ่งวันต้องไม่สั้นกว่าช่วงผ่อนผัน · เขตเวลาต้องถูก', async () => {
    expect((await owner.patch('/v1/settings').set(json).send({ lateGraceMinutes: 300 })).body.error).toBe('half_day_before_grace');
    expect((await owner.patch('/v1/orgs/current').set(json).send({ timezone: 'Mars/Base' })).status).toBe(400);
    const ok = await owner.patch('/v1/orgs/current').set(json).send({ name: `Koh Tao ${s}`, timezone: 'Asia/Bangkok' });
    expect(ok.body.name).toBe(`Koh Tao ${s}`);
  });

  it('เพดานส่วนลดรายคนมีผลที่ฐานข้อมูล', async () => {
    expect((await owner.patch(`/v1/members/${staffId}/discount-limit`).set(json).send({ limit: 5_000 })).status).toBe(200);
    const bills = await staff.get('/v1/bills');
    ids.bill = bills.body.find((b: { customerId: string }) => b.customerId === ids.cust).id;
    const over = await staff.post(`/v1/bills/${ids.bill}/lines`).set(json).send({ kind: 'discount', description: 'ส่วนลด', amount: 6_000, reason: 'ลูกค้าประจำ' });
    expect(over.status).toBe(403);
    expect(over.body.error).toBe('discount_over_limit');
    const settings = await owner.get('/v1/settings');
    expect(settings.body.staff.find((m: { userId: string }) => m.userId === staffId).discountLimit).toBe(5_000);
    expect((await staff.patch(`/v1/members/${staffId}/discount-limit`).set(json).send({ limit: null })).status).toBe(403);
  });
});

describe('รายงาน', () => {
  it('ตัวเลขตรงกับชุดข้อมูลที่รู้ค่า', async () => {
    // C-03 เช่ามาแล้ว 10 ชม. → รับคืนตอนนี้ + ค่าน้ำมัน · ลด ฿50 ระดับบิล · รับเงินสดครบ
    const r3 = randomUUID();
    const start = new Date(Date.now() - 10 * 3_600_000).toISOString();
    expect((await staff.post('/v1/rentals').set(json).send({ id: r3, customerId: ids.cust, days: 1, startAt: start, items: [{ assetId: ids['C-03'] }] })).status).toBe(201);
    expect((await staff.post(`/v1/rentals/${r3}/return`).set(json).send({ fuel: 6_000 })).status).toBe(200);
    expect((await staff.post(`/v1/bills/${ids.bill}/lines`).set(json).send({ kind: 'discount', description: 'ส่วนลด', amount: 5_000, reason: 'ลูกค้าประจำ' })).status).toBe(201);
    await staff.post(`/v1/rentals/${ids.finsRental}/return`).set(json).send({});
    const bill = await staff.get(`/v1/bills/${ids.bill}`);
    expect(bill.body.balance).toBe(20_000 + 25_000 + 6_000 - 5_000);
    expect((await staff.post(`/v1/bills/${ids.bill}/payments`).set(json).send({ payments: [{ method: 'cash', amount: 46_000 }] })).body.status).toBe('paid');

    const yesterday = addDays(today, -1);
    const rep = await owner.get(`/v1/reports/summary?from=${yesterday}&to=${today}`);
    expect(rep.status).toBe(200);
    const kinds = Object.fromEntries(rep.body.revenueByKind.map((k: { kind: string; amount: number }) => [k.kind, k.amount]));
    expect(kinds).toEqual({ gear: 20_000, rental: 25_000, fuel: 6_000, discount: -5_000 });
    expect(rep.body.totals.revenue).toBe(46_000);
    expect(rep.body.totals.unattributedRevenue).toBe(-5_000);
    expect(rep.body.paymentsByMethod).toEqual([{ method: 'cash', amount: 46_000, count: 1 }]);
    expect(rep.body.daily).toHaveLength(2);
    expect(rep.body.daily.reduce((s: number, d: { revenue: number }) => s + d.revenue, 0)).toBe(46_000);

    const types = Object.fromEntries(rep.body.revenueByType.map((t: { name: string; revenue: number }) => [t.name, t.revenue]));
    expect(types).toEqual({ Click: 31_000, ตีนกบ: 20_000 });
    const byCode = Object.fromEntries(rep.body.assets.map((x: { code: string }) => [x.code, x]));
    expect(byCode['C-03']).toMatchObject({ revenue: 31_000, maintenanceCost: 0, profit: 31_000 });
    expect(byCode['C-03'].rentedHours).toBeGreaterThan(9.9);
    expect(byCode['C-03'].rentedHours).toBeLessThan(10.2);
    expect(byCode['C-03'].utilizationPct).toBeGreaterThan(0);
    expect(byCode['C-01']).toMatchObject({ revenue: 0, maintenanceCost: 35_000, profit: -35_000, utilizationPct: 0 });
    expect(rep.body.totals.openBills).toBe(0);
    expect(rep.body.channels).toMatchObject({ hotelGuests: 2, nonHotel: 0 });
  });

  it('ส่งออก CSV มี BOM · พนักงานดูรายงานไม่ได้', async () => {
    const r = await owner.get(`/v1/reports/summary.csv?from=${today}&to=${today}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
    });
    expect(r.headers['content-type']).toContain('text/csv');
    expect((r.body as string).charCodeAt(0)).toBe(0xfeff);
    expect(r.body as string).toContain('C-03');
    expect((await staff.get('/v1/reports/summary')).status).toBe(403);
    expect((await owner.get('/v1/reports/summary?from=2026-12-01&to=2026-11-01')).body.error).toBe('invalid_date_range');
  });
});

describe('ประวัติการใช้งาน', () => {
  it('พนักงานเปิดไม่ได้', async () => {
    expect((await staff.get('/v1/audit')).status).toBe(403);
    expect((await staff.get('/v1/audit.csv')).status).toBe(403);
  });

  it('กรองตามหมวด ความเสี่ยง และคน', async () => {
    const m = await owner.get('/v1/audit?action=maintenance');
    expect(m.body.items.map((i: { action: string }) => i.action)).toEqual(['maintenance.recorded', 'maintenance.recorded']);
    expect(m.body.items[0]).toMatchObject({ actorName: `p2s.${s}`, entityType: 'asset' });
    const risky = await owner.get('/v1/audit?risk=risky');
    const actions = risky.body.items.map((i: { action: string }) => i.action);
    expect(actions).toContain('member.discount_limit_changed');
    expect(risky.body.items.every((i: { risk: string }) => i.risk === 'risky')).toBe(true);
    const byStaff = await owner.get(`/v1/audit?actor=${staffId}`);
    expect(byStaff.body.items.length).toBeGreaterThan(0);
    expect(byStaff.body.items.every((i: { actorId: string }) => i.actorId === staffId)).toBe(true);
    expect(byStaff.body.actors.map((x: { id: string }) => x.id)).toContain(staffId);
    expect((await owner.get('/v1/audit?action=drop%20table')).status).toBe(400);
  });

  it('แบ่งหน้าละ 50 รายการ เรียงใหม่ไปเก่า ไม่ซ้ำ ไม่ขาด', async () => {
    for (let i = 0; i < 55; i++) {
      await staff.post('/v1/maintenance').set(json).send({ assetId: ids['C-02'], kind: 'other', description: `ล้างรถ ${i}`, cost: 0, performedOn: today });
    }
    const p1 = await owner.get('/v1/audit?action=maintenance.recorded');
    expect(p1.body.items).toHaveLength(50);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await owner.get(`/v1/audit?action=maintenance.recorded&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items).toHaveLength(7);
    expect(p2.body.nextCursor).toBeNull();
    const all = [...p1.body.items, ...p2.body.items].map((i: { id: number }) => i.id);
    expect(new Set(all).size).toBe(57);
    expect([...all].sort((x, y) => y - x)).toEqual(all);
  });

  it('CSV มี BOM และกรองได้', async () => {
    const r = await owner.get('/v1/audit.csv?action=stock').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
    });
    const text = r.body as string;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toContain('action');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('stock.adjusted');
    expect(lines[1]).toContain('ซื้อเพิ่ม');
  });
});
