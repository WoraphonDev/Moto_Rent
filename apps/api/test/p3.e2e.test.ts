// เฟส 3 ทั้งเส้น: หน้าจองสาธารณะ → ร้านยืนยัน/กำหนดคัน → ปล่อยเช่าจากคำขอ · กันจองซ้อน · ยกเลิกเอง · เทมเพลตข้อความ
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addStaff, json, signupShop, startApp, suffix, type Agent } from './helpers.js';

let app: INestApplication;
let owner: Agent;
let staff: Agent;
const s = suffix();
const slug = `shop-${s}`;
type Key = 'atv' | 'a01' | 'a02' | 'gear' | 'gearL' | 'codeA' | 'tokenA' | 'bookingA' | 'customerA' | 'rentalA';
const ids = {} as Record<Key, string>;
const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const pub = () => request(app.getHttpServer());

function bookingPayload(over: Record<string, unknown> = {}) {
  return {
    fullName: 'Anna Schmidt',
    whatsapp: '+49 170 1234567',
    email: 'anna@example.com',
    hotelRoom: '215',
    hasLicense: true,
    pickupAt: hours(48),
    days: 2,
    items: [{ typeId: ids.atv, quantity: 1 }],
    startedAt: Date.now() - 10_000,
    website: '',
    ...over,
  };
}

async function createBooking(over: Record<string, unknown> = {}) {
  const r = await pub().post(`/v1/public/shops/${slug}/bookings`).set(json).send(bookingPayload(over));
  if (r.status !== 201) throw new Error(`booking failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { code: string; manageUrl: string; manageToken: string };
}

async function bookingByCode(code: string) {
  const list = await staff.get('/v1/bookings');
  return (list.body as Array<{ id: string; code: string }>).find((b) => b.code === code)!;
}

beforeAll(async () => {
  app = await startApp();
  owner = await signupShop(app, s);
  // ร้านใหม่ปิดหน้าจองออนไลน์ไว้ก่อน (migration 0009) · เจ้าของต้องเปิดเอง
  await owner.patch('/v1/settings').set(json).send({ publicBookingEnabled: true });
  staff = await addStaff(app, owner, `p3staff.${s}`);
  const atv = await owner.post('/v1/asset-types').set(json).send({ name: 'ATV', tracking: 'unit', codePrefix: 'A-', pricePerDay: 70_000 });
  ids.atv = atv.body.id;
  ids.a01 = (await owner.post('/v1/assets').set(json).send({ assetTypeId: ids.atv })).body.id;
  ids.a02 = (await owner.post('/v1/assets').set(json).send({ assetTypeId: ids.atv })).body.id;
  const gear = await owner.post('/v1/asset-types').set(json).send({ name: 'Snorkel set', tracking: 'quantity', pricePerDay: 10_000 });
  ids.gear = gear.body.id;
  ids.gearL = (await owner.post(`/v1/asset-types/${ids.gear}/variants`).set(json).send({ label: 'L', quantity: 2 })).body.id;
});
afterAll(async () => {
  await app.close();
});

describe('หน้าจองสาธารณะ', () => {
  it('ข้อมูลร้าน: ประเภทและราคา ไม่มี orgId ไม่มีรหัสรถ', async () => {
    const r = await pub().get(`/v1/public/shops/${slug}`);
    expect(r.status).toBe(200);
    expect(r.body.orgId).toBeUndefined();
    expect(r.body.types.map((t: { name: string }) => t.name)).toEqual(['ATV', 'Snorkel set']);
    expect(JSON.stringify(r.body)).not.toContain('A-01');
    expect((await pub().get('/v1/public/shops/no-such-shop-zz')).status).toBe(404);
  });

  it('ความว่าง: ATV 2 คัน · ไซส์ L 2 ชุด', async () => {
    const r = await pub().get(`/v1/public/shops/${slug}/availability?from=${encodeURIComponent(hours(48))}&to=${encodeURIComponent(hours(96))}`);
    expect(r.status).toBe(200);
    const atv = r.body.types.find((t: { id: string }) => t.id === ids.atv);
    const gear = r.body.types.find((t: { id: string }) => t.id === ids.gear);
    expect(atv.available).toBe(2);
    expect(gear.variants[0]).toMatchObject({ label: 'L', available: 2 });
  });

  it('กับดัก bot: กรอกช่องซ่อน หรือส่งเร็วเกิน 3 วินาที ถูกปฏิเสธ', async () => {
    expect((await pub().post(`/v1/public/shops/${slug}/bookings`).set(json).send(bookingPayload({ website: 'http://spam' }))).status).toBe(400);
    expect((await pub().post(`/v1/public/shops/${slug}/bookings`).set(json).send(bookingPayload({ startedAt: Date.now() }))).status).toBe(400);
  });

  it('ส่งคำขอได้รหัสจอง + ลิงก์ส่วนตัว · หน้าดูการจองปิดเบอร์และไม่มีอีเมล', async () => {
    const r = await createBooking();
    expect(r.code).toMatch(/^S[A-Z]?-?[A-Z2-9]{0,4}/);
    expect(r.manageUrl).toContain(`/b/${r.manageToken}`);
    ids.codeA = r.code;
    ids.tokenA = r.manageToken;
    const v = await pub().get(`/v1/public/bookings/${r.manageToken}`);
    expect(v.body).toMatchObject({ code: r.code, status: 'requested', whatsappMasked: '••• 567', cancellable: true, total: 140_000 });
    expect(JSON.stringify(v.body)).not.toContain('anna@example.com');
  });
});

describe('ร้านยืนยันคำขอ', () => {
  it('รายการรอยืนยัน: แนะนำคันที่ว่าง', async () => {
    const b = await bookingByCode(ids.codeA);
    ids.bookingA = b.id;
    const d = await staff.get(`/v1/bookings/${b.id}`);
    expect(d.body.status).toBe('requested');
    expect(d.body.suggestions[ids.atv].map((x: { code: string }) => x.code)).toEqual(['A-01', 'A-02']);
    expect(d.body.manageTokenHash).toBeUndefined();
  });

  it('ยืนยันโดยกำหนด A-01 → สร้าง/ผูกลูกค้า', async () => {
    const d = await staff.get(`/v1/bookings/${ids.bookingA}`);
    const item = d.body.items[0];
    const missing = await staff.post(`/v1/bookings/${ids.bookingA}/confirm`).set(json).send({ assignments: [] });
    expect(missing.status).toBe(400);
    const r = await staff.post(`/v1/bookings/${ids.bookingA}/confirm`).set(json).send({ assignments: [{ itemId: item.id, assetId: ids.a01 }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'confirmed' });
    expect(r.body.customerId).toBeTruthy();
    expect(r.body.items[0].assetCode).toBe('A-01');
    ids.customerA = r.body.customerId;
  });

  it('คำขออีกใบช่วงทับกัน กำหนด A-01 ซ้ำไม่ได้ · ปฏิเสธพร้อมเหตุผลได้', async () => {
    const b = await createBooking({ fullName: 'Tom Hughes', whatsapp: '+44 7700 900123', hotelRoom: '', pickupAt: hours(60) });
    const bk = await bookingByCode(b.code);
    const d = await staff.get(`/v1/bookings/${bk.id}`);
    expect(d.body.suggestions[ids.atv].map((x: { code: string }) => x.code)).toEqual(['A-02']);
    expect(d.body.warnings).toContain('ลูกค้านอกโรงแรม · ควรเก็บมัดจำ');
    const r = await staff.post(`/v1/bookings/${bk.id}/confirm`).set(json).send({ assignments: [{ itemId: d.body.items[0].id, assetId: ids.a01 }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('asset_reserved');
    const rej = await staff.post(`/v1/bookings/${bk.id}/reject`).set(json).send({ reason: 'รถเต็มช่วงนั้น' });
    expect(rej.body).toMatchObject({ status: 'rejected', rejectReason: 'รถเต็มช่วงนั้น' });
    const view = await pub().get(`/v1/public/bookings/${b.manageToken}`);
    expect(view.body.status).toBe('rejected');
  });

  it('หน้าจองเห็นว่า ATV เหลือ 1 คันในช่วงที่ยืนยันแล้ว', async () => {
    const r = await pub().get(`/v1/public/shops/${slug}/availability?from=${encodeURIComponent(hours(50))}&to=${encodeURIComponent(hours(70))}`);
    expect(r.body.types.find((t: { id: string }) => t.id === ids.atv).available).toBe(1);
  });
});

describe('ปล่อยเช่ากับรถที่ถูกจอง', () => {
  it('ปล่อย A-01 ให้คนอื่นทับช่วงที่จองไว้ไม่ได้', async () => {
    const c = await staff.post('/v1/customers').set(json).send({ fullName: 'Walk In' });
    const r = await staff.post('/v1/rentals').set(json).send({ id: randomUUID(), customerId: c.body.id, days: 3, items: [{ assetId: ids.a01 }] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'asset_reserved', code: 'A-01', bookingCode: ids.codeA });
  });

  it('ปล่อยจากคำขอจองเอง → คำขอเป็น "รับรถแล้ว" และผูกสัญญา', async () => {
    const id = randomUUID();
    const r = await staff
      .post('/v1/rentals')
      .set(json)
      .send({ id, customerId: ids.customerA, bookingId: ids.bookingA, days: 2, channel: 'booking_page', items: [{ assetId: ids.a01 }] });
    expect(r.status).toBe(201);
    const b = await staff.get(`/v1/bookings/${ids.bookingA}`);
    expect(b.body).toMatchObject({ status: 'picked_up', rentalId: id });
    expect(b.body.items.every((i: { active: boolean }) => !i.active)).toBe(true);
    ids.rentalA = id;
  });

  it('ปฏิทินรถ: A-01 มีช่วงสัญญาเช่า', async () => {
    const r = await staff.get('/v1/bookings/calendar?days=14');
    expect(r.status).toBe(200);
    expect(r.body.days).toBe(14);
    const a01 = r.body.assets.find((x: { code: string }) => x.code === 'A-01');
    expect(a01.segments.some((g: { kind: string; refId: string }) => g.kind === 'rental' && g.refId === ids.rentalA)).toBe(true);
  });
});

describe('ไม่มารับ · ยกเลิกเอง', () => {
  it('คำขอที่ยืนยันแล้วแต่ไม่มารับ → ปล่อยคันคืน', async () => {
    const b = await createBooking({ fullName: 'Mia Rossi', whatsapp: '+39 333 1234567', pickupAt: hours(300), days: 1 });
    const bk = await bookingByCode(b.code);
    const d = await staff.get(`/v1/bookings/${bk.id}`);
    await staff.post(`/v1/bookings/${bk.id}/confirm`).set(json).send({ assignments: [{ itemId: d.body.items[0].id, assetId: ids.a02 }] });
    const r = await staff.post(`/v1/bookings/${bk.id}/no-show`).set(json).send({});
    expect(r.body.status).toBe('no_show');
    const av = await pub().get(`/v1/public/shops/${slug}/availability?from=${encodeURIComponent(hours(301))}&to=${encodeURIComponent(hours(302))}`);
    expect(av.body.types.find((t: { id: string }) => t.id === ids.atv).available).toBe(2);
  });

  it('ลูกค้ายกเลิกเองได้ถ้าเหลือเกิน 2 ชม. · ใกล้เวลารับยกเลิกเองไม่ได้', async () => {
    const far = await createBooking({ fullName: 'Noa Cohen', whatsapp: '+972 50 1234567', items: [{ typeId: ids.gear, variantId: ids.gearL, quantity: 1 }], pickupAt: hours(120) });
    const c = await pub().post(`/v1/public/bookings/${far.manageToken}/cancel`).set('x-requested-with', 'fetch');
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('cancelled');
    const near = await createBooking({ fullName: 'Daniel Kim', whatsapp: '+82 10 1234 5678', pickupAt: hours(1) });
    const n = await pub().post(`/v1/public/bookings/${near.manageToken}/cancel`).set('x-requested-with', 'fetch');
    expect(n.status).toBe(409);
    expect(n.body.error).toBe('booking_not_cancellable');
  });
});

describe('เทมเพลตข้อความ WhatsApp', () => {
  it('มีค่าเริ่มต้น 5 แบบ · พนักงานแก้ไม่ได้ เจ้าของแก้ได้', async () => {
    const list = await staff.get('/v1/message-templates');
    expect(list.body.map((t: { key: string }) => t.key)).toEqual(['booking_confirmed', 'booking_rejected', 'return_reminder', 'receipt', 'thank_you']);
    expect((await staff.put('/v1/message-templates/thank_you').set(json).send({ body: 'Thanks {name}!' })).status).toBe(403);
    const put = await owner.put('/v1/message-templates/thank_you').set(json).send({ body: 'Thanks {name} from {shop}!' });
    expect(put.status).toBe(200);
  });

  it('เติมตัวแปรจากคำขอจอง แล้วได้ลิงก์ wa.me', async () => {
    const r = await staff.post('/v1/message-templates/booking_confirmed/render').set(json).send({ bookingId: ids.bookingA });
    expect(r.status).toBe(200);
    expect(r.body.text).toContain(ids.codeA);
    expect(r.body.text).toContain('Anna Schmidt');
    expect(r.body.waUrl).toMatch(/^https:\/\/wa\.me\/491701234567\?text=/);
    const t = await staff.post('/v1/message-templates/thank_you/render').set(json).send({ rentalId: ids.rentalA });
    expect(t.body.text).toBe(`Thanks Anna Schmidt from Shop ${s}!`);
  });
});

describe('แยกข้อมูลระหว่างร้าน · จำกัดจำนวนครั้ง', () => {
  it('ร้านอื่นไม่เห็นคำขอจองของร้านนี้', async () => {
    const other = await signupShop(app, suffix());
    expect((await other.get('/v1/bookings')).body).toEqual([]);
    expect((await other.get(`/v1/bookings/${ids.bookingA}`)).status).toBe(404);
    expect((await other.post(`/v1/bookings/${ids.bookingA}/reject`).set(json).send({ reason: 'xx' })).status).toBe(404);
  });

  it('เบอร์เดียวส่งคำขอได้ไม่เกิน 5 ครั้งต่อวัน', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await pub()
        .post(`/v1/public/shops/${slug}/bookings`)
        .set(json)
        .send(bookingPayload({ whatsapp: '+66 81 999 0000', pickupAt: hours(400 + i * 50), days: 1 }));
      statuses.push(r.status);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('ปฏิทินหน้าจอง', () => {
  it('คืนความว่างรายวันในคำขอเดียว · วันที่ผ่านไปแล้วถือว่าจองไม่ได้', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = await pub().get(`/v1/public/shops/${slug}/calendar?from=${today}&span=2&count=10&hour=10`);
    expect(r.status).toBe(200);
    expect(r.body.days).toHaveLength(10);
    expect(r.body.days[9].past).toBe(false);
    expect(r.body.days[9].types.find((t: { id: string }) => t.id === ids.atv).available).toBeGreaterThanOrEqual(1);
  });
});
