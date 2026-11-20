// แก้จากการตรวจความปลอดภัย: หน้าจองสาธารณะ (เปิด/ปิดหน้าจอง · ปฏิทิน · เบอร์ · ชื่อมีลิงก์ · เพดานต่อร้าน)
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientKey } from '../src/common/rate-limit.js';
import { addStaff, json, signupShop, startApp, suffix, type Agent } from './helpers.js';

// เพดานคำขอต่อร้านต่อวัน: production 50 · เทสต์ลดเหลือ 4 (อ่านตอนโหลดโมดูล ไฟล์เทสต์นี้รันแยก process)
process.env.PUBLIC_BOOKING_DAILY_CAP = '4';

let app: INestApplication;
let owner: Agent;
let staff: Agent;
let valkey: Redis;
const s = suffix();
const slug = `shop-${s}`;
const ids: Record<string, string> = {};
const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const pub = () => request(app.getHttpServer());

function payload(over: Record<string, unknown> = {}) {
  return {
    fullName: 'Lukas Becker',
    whatsapp: '+49 151 1234 5678',
    hasLicense: true,
    pickupAt: hours(48),
    days: 1,
    items: [{ typeId: ids.click, quantity: 1 }],
    startedAt: Date.now() - 10_000,
    website: '',
    ...over,
  };
}

beforeAll(async () => {
  app = await startApp();
  valkey = new Redis(process.env.VALKEY_URL!);
  owner = await signupShop(app, s);
  staff = await addStaff(app, owner, `fpstaff.${s}`);
  ids.click = (await owner.post('/v1/asset-types').set(json).send({ name: 'Click', tracking: 'unit', codePrefix: 'C-', pricePerDay: 25_000 })).body.id;
  for (let i = 0; i < 3; i++) await owner.post('/v1/assets').set(json).send({ assetTypeId: ids.click });
});
afterAll(async () => {
  await valkey.quit();
  await app.close();
});

describe('ร้านต้องเปิดหน้าจองเอง', () => {
  it('ร้านใหม่: หน้าจองตอบ 404 เหมือนไม่มีร้าน', async () => {
    expect((await pub().get(`/v1/public/shops/${slug}`)).status).toBe(404);
    expect((await pub().get(`/v1/public/shops/${slug}/availability?from=${encodeURIComponent(hours(24))}&to=${encodeURIComponent(hours(48))}`)).status).toBe(404);
    const today = new Date().toISOString().slice(0, 10);
    expect((await pub().get(`/v1/public/shops/${slug}/calendar?from=${today}&count=3`)).status).toBe(404);
    const create = await pub().post(`/v1/public/shops/${slug}/bookings`).set(json).send(payload());
    expect(create.status).toBe(404);
    expect(create.body.error).toBe('shop_not_found');
  });

  it('พนักงานเปิดหน้าจองไม่ได้ · เจ้าของเปิดได้และเห็นในตั้งค่า', async () => {
    expect((await staff.patch('/v1/settings').set(json).send({ publicBookingEnabled: true })).status).toBe(403);
    const r = await owner.patch('/v1/settings').set(json).send({ publicBookingEnabled: true });
    expect(r.status).toBe(200);
    expect(r.body.publicBookingEnabled).toBe(true);
    expect((await owner.get('/v1/settings')).body.settings.publicBookingEnabled).toBe(true);
    expect((await pub().get(`/v1/public/shops/${slug}`)).status).toBe(200);
  });
});

describe('ปฏิทิน', () => {
  it('วันที่ไม่มีจริง (30 ก.พ.) ตอบ 400 ไม่ใช่ 500', async () => {
    const r = await pub().get(`/v1/public/shops/${slug}/calendar?from=2027-02-30&count=3`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_range');
  });

  it('ช่วงความว่างเกิน 61 วันตอบ 400', async () => {
    const r = await pub().get(`/v1/public/shops/${slug}/availability?from=${encodeURIComponent(hours(1))}&to=${encodeURIComponent(hours(1 + 62 * 24))}`);
    expect(r.status).toBe(400);
  });

  it('เก็บผลไว้ใน Valkey · คำขอซ้ำได้ผลเดิมจากแคช', async () => {
    const day = hours(24 * 3).slice(0, 10);
    const url = `/v1/public/shops/${slug}/calendar?from=${day}&span=1&count=5&hour=10`;
    const a = await pub().get(url);
    expect(a.status).toBe(200);
    const key = `pubcal:${slug}:${day}:1:5:10`;
    expect(await valkey.exists(key)).toBe(1);
    expect(await valkey.ttl(key)).toBeLessThanOrEqual(60);
    // เขียนค่าในแคชทับ: ถ้าคำขอถัดไปได้ค่านี้ แปลว่าไม่ได้คำนวณใหม่จากฐานข้อมูล
    await valkey.set(key, JSON.stringify({ cached: true }), 'EX', 60);
    const b = await pub().get(url);
    expect(b.body).toEqual({ cached: true });
  });

  it('ปฏิทินกินโควตาตามจำนวนวัน', async () => {
    await valkey.del(...(await valkey.keys('rl:pub-read:*')));
    const day = hours(24 * 4).slice(0, 10);
    const statuses: number[] = [];
    // โควตา 300 ต่อ 10 นาที · ครั้งละ 42 วัน → ครั้งที่ 8 เกิน (8 × 42 = 336)
    for (let i = 0; i < 8; i++) statuses.push((await pub().get(`/v1/public/shops/${slug}/calendar?from=${day}&span=${i + 1}&count=42`)).status);
    expect(statuses.slice(0, 7).every((x) => x === 200)).toBe(true);
    expect(statuses[7]).toBe(429);
    await valkey.del(...(await valkey.keys('rl:pub-read:*')));
  });
});

describe('ข้อมูลคำขอจอง', () => {
  it('ชื่อที่มีลิงก์ถูกปฏิเสธ (กันข้อความหลอกส่งต่อทาง WhatsApp ของร้าน)', async () => {
    for (const fullName of ['Pay deposit at evil.com', 'Visit https://x.y now', 'www.scam.top']) {
      const r = await pub().post(`/v1/public/shops/${slug}/bookings`).set(json).send(payload({ fullName }));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_name');
    }
  });

  it('เบอร์ที่มีตัวเลขไม่ถึง 8 หลักถูกปฏิเสธ', async () => {
    const r = await pub().post(`/v1/public/shops/${slug}/bookings`).set(json).send(payload({ whatsapp: '((((((((((' }));
    expect(r.status).toBe(400);
  });

  it('+66 81… กับ 081… นับเป็นเบอร์เดียวกันในโควตาต่อเบอร์ · ลิงก์ในหมายเหตุถูกตัดออก', async () => {
    await valkey.del(...((await valkey.keys('rl:pub-book-*')) as string[]).concat('rl:none'));
    const forms = ['+66 81 555 0101', '0815550101', '+66815550101', '081-555-0101', '+66 (81) 555 0101'];
    const statuses: number[] = [];
    for (let i = 0; i < forms.length; i++) {
      const r = await pub()
        .post(`/v1/public/shops/${slug}/bookings`)
        .set(json)
        .send(payload({ whatsapp: forms[i], pickupAt: hours(100 + i * 30), notes: i === 0 ? 'Call me www.evil.com please' : undefined }));
      statuses.push(r.status);
      if (i === 0) {
        const view = await pub().get(`/v1/public/bookings/${r.body.manageToken}`);
        expect(JSON.stringify(view.body)).not.toContain('evil.com');
      }
    }
    // เพดานต่อร้าน (เทสต์ = 4) ถึงก่อนเพดานต่อเบอร์ (5) · เลยล้างแล้วทดสอบเบอร์แยก
    expect(statuses.slice(0, 4).every((x) => x === 201)).toBe(true);
    expect(statuses[4]).toBe(429);
  });

  it('เพดานต่อเบอร์: เบอร์รูปแบบต่างกันชนกันจริง', async () => {
    await valkey.del(...((await valkey.keys('rl:pub-book-*')) as string[]).concat('rl:none'));
    const k = '815550202';
    // จำลองว่าเบอร์นี้ส่งไปแล้ว 5 ครั้ง (ในรูปแบบ +66)
    await valkey.set(`rl:pub-book-phone:${k}`, 5, 'EX', 600);
    const r = await pub().post(`/v1/public/shops/${slug}/bookings`).set(json).send(payload({ whatsapp: '081 555 0202', pickupAt: hours(700) }));
    expect(r.status).toBe(429);
  });

  it('เพดานต่อร้านต่อวัน', async () => {
    await valkey.del(...((await valkey.keys('rl:pub-book-*')) as string[]).concat('rl:none'));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await pub()
        .post(`/v1/public/shops/${slug}/bookings`)
        .set(json)
        .send(payload({ whatsapp: `+49 151 0000 00${10 + i}`, pickupAt: hours(800 + i * 30) }));
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 4).every((x) => x === 201)).toBe(true);
    expect(statuses[4]).toBe(429);
  });
});

describe('clientKey', () => {
  it('IPv4 ตามเดิม · IPv4-mapped เป็น v4 · IPv6 รวมเป็น /64', () => {
    expect(clientKey({ ip: '203.0.113.7' })).toBe('203.0.113.7');
    expect(clientKey({ ip: '::ffff:203.0.113.7' })).toBe('203.0.113.7');
    expect(clientKey({ ip: '2001:db8:abcd:12:1:2:3:4' })).toBe('2001:db8:abcd:12::/64');
    expect(clientKey({ ip: '2001:db8:abcd:12::99' })).toBe('2001:db8:abcd:12::/64');
    expect(clientKey({ ip: '2001:db8::1' })).toBe('2001:db8:0:0::/64');
    expect(clientKey({ ip: '' })).toBe('unknown');
  });
});
