// เฟส 3: ฟังก์ชันหน้าจองสาธารณะ (pub.*) และกฎกันจองซ้อน
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant, type Db } from '../src/index.ts';

const APP_URL = process.env.DATABASE_APP_URL ?? 'postgres://rental_api:rental_api_dev@localhost:54330/rental';
const s = randomBytes(3).toString('hex');
let db: Db;

interface Shop {
  slug: string;
  orgId: string;
  owner: string;
  typeId: string;
  assetId: string;
}

async function rejects(p: Promise<unknown>, pattern: RegExp) {
  try {
    await p;
  } catch (e) {
    const err = e as { message: string; cause?: { message?: string } };
    expect(err.cause?.message ?? err.message).toMatch(pattern);
    return;
  }
  throw new Error(`expected rejection matching ${pattern}`);
}

async function shop(tag: string): Promise<Shop> {
  const slug = `${tag}-shop-${s}`;
  const r = await db.execute<{ org_id: string; user_id: string }>(sql`select * from auth.create_org(${slug}, ${`Shop ${tag}`}, ${`${tag}.p3.${s}`}, 'o', null, 'h')`);
  const { org_id: orgId, user_id: owner } = r.rows[0]!;
  const ids = await withTenant(db, { userId: owner, orgId }, async (tx) => {
    const t = await tx.execute<{ id: string }>(sql`insert into asset_types (org_id, name, tracking, code_prefix, price_per_day) values (${orgId}, 'ATV', 'unit', 'A-', 70000) returning id`);
    const a = await tx.execute<{ id: string }>(sql`insert into assets (org_id, asset_type_id, code) values (${orgId}, ${t.rows[0]!.id}, 'A-01') returning id`);
    return { typeId: t.rows[0]!.id, assetId: a.rows[0]!.id };
  });
  return { slug, orgId, owner, ...ids };
}

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function book(sh: Shop, pickupHours: number, token = randomBytes(8).toString('hex'), qty = 1) {
  const payload = { fullName: 'Anna Schmidt', whatsapp: '+491701234567', email: 'anna@example.com', hotelRoom: '215', pickupAt: hoursFromNow(pickupHours), days: 2, items: [{ typeId: sh.typeId, quantity: qty }] };
  const r = await db.execute<{ booking_id: string; booking_code: string }>(sql`select * from pub.create_booking(${sh.slug}, ${JSON.stringify(payload)}::jsonb, ${token}, '127.0.0.1')`);
  return { ...r.rows[0]!, token };
}

let a: Shop;
let b: Shop;

beforeAll(async () => {
  db = createDb(APP_URL, 4);
  a = await shop('pa');
  b = await shop('pb');
});
afterAll(async () => {
  await db.$client.end();
});

describe('pub.shop / pub.availability', () => {
  it('คืนเฉพาะประเภทของร้านนั้น และไม่คืนรหัสรถ', async () => {
    const r = await db.execute<{ j: { name: string; types: Array<{ id: string }> } }>(sql`select pub.shop(${a.slug}) as j`);
    expect(r.rows[0]!.j.name).toBe('Shop pa');
    expect(r.rows[0]!.j.types.map((t) => t.id)).toEqual([a.typeId]);
    expect(JSON.stringify(r.rows[0]!.j)).not.toContain('A-01');
  });

  it('ร้านที่ไม่มี = null', async () => {
    const r = await db.execute<{ j: unknown }>(sql`select pub.shop('no-such-shop') as j`);
    expect(r.rows[0]!.j).toBeNull();
  });

  it('ว่าง 1 คันก่อนมีการยืนยัน', async () => {
    const r = await db.execute<{ j: { types: Array<{ id: string; available: number }> } }>(
      sql`select pub.availability(${a.slug}, ${hoursFromNow(48)}::timestamptz, ${hoursFromNow(96)}::timestamptz) as j`,
    );
    expect(r.rows[0]!.j.types.find((t) => t.id === a.typeId)!.available).toBe(1);
  });
});

describe('pub.create_booking / booking_by_token', () => {
  it('สร้างคำขอ รหัสขึ้นต้นจากชื่อร้าน · หน้าดูการจองปิดเบอร์และไม่มีอีเมล', async () => {
    const r = await book(a, 48);
    expect(r.booking_code).toMatch(/^PS-[A-Z2-9]{4}$/);
    const v = await db.execute<{ j: Record<string, unknown> }>(sql`select pub.booking_by_token(${r.token}) as j`);
    const j = v.rows[0]!.j;
    expect(j).toMatchObject({ status: 'requested', whatsappMasked: '••• 567', cancellable: true, total: 2 * 70000 });
    expect(JSON.stringify(j)).not.toContain('anna@example.com');
    expect(JSON.stringify(j)).not.toContain('1701234');
  });

  it('รับรถในอดีตหรือเกินวันสูงสุดไม่ได้ · ประเภทของร้านอื่นไม่ได้', async () => {
    await rejects(book(a, -1), /invalid_pickup/);
    const tooLong = { fullName: 'x', whatsapp: '1', pickupAt: hoursFromNow(48), days: 16, items: [{ typeId: a.typeId, quantity: 1 }] };
    await rejects(db.execute(sql`select * from pub.create_booking(${a.slug}, ${JSON.stringify(tooLong)}::jsonb, 'x1', null)`), /too_many_days/);
    const cross = { fullName: 'x', whatsapp: '1', pickupAt: hoursFromNow(48), days: 1, items: [{ typeId: b.typeId, quantity: 1 }] };
    await rejects(db.execute(sql`select * from pub.create_booking(${a.slug}, ${JSON.stringify(cross)}::jsonb, 'x2', null)`), /invalid_item/);
  });

  it('ขอเกินจำนวนที่ว่างไม่ได้', async () => {
    await rejects(book(a, 48, undefined, 2), /not_available/);
  });

  it('token ที่ไม่มีอยู่ = null', async () => {
    const v = await db.execute<{ j: unknown }>(sql`select pub.booking_by_token('nope') as j`);
    expect(v.rows[0]!.j).toBeNull();
  });
});

describe('กันจองซ้อน (booking_items_no_overlap)', () => {
  it('ยืนยันคันเดียวกันในช่วงที่ทับกันสองคำขอไม่ได้ · หลังยืนยันหน้าจองเห็นว่าไม่ว่าง', async () => {
    const r1 = await book(a, 200);
    const r2 = await book(a, 210);
    const confirm = (bookingId: string, start: number) =>
      withTenant(db, { userId: a.owner, orgId: a.orgId }, (tx) =>
        tx.execute(sql`update booking_items set asset_id = ${a.assetId}, active = true,
          during = tstzrange(${hoursFromNow(start)}::timestamptz, ${hoursFromNow(start + 48)}::timestamptz) where booking_id = ${bookingId}`),
      );
    await confirm(r1.booking_id, 200);
    await rejects(confirm(r2.booking_id, 210), /booking_items_no_overlap/);
    const av = await db.execute<{ j: { types: Array<{ id: string; available: number }> } }>(
      sql`select pub.availability(${a.slug}, ${hoursFromNow(220)}::timestamptz, ${hoursFromNow(230)}::timestamptz) as j`,
    );
    expect(av.rows[0]!.j.types.find((t) => t.id === a.typeId)!.available).toBe(0);
    await rejects(book(a, 220), /not_available/);
  });
});

describe('pub.cancel_booking', () => {
  it('ยกเลิกได้ก่อนรับรถเกิน 2 ชม. และปลดของที่กันไว้', async () => {
    const r = await book(b, 100);
    await withTenant(db, { userId: b.owner, orgId: b.orgId }, (tx) =>
      tx.execute(sql`update booking_items set asset_id = ${b.assetId}, active = true, during = tstzrange(${hoursFromNow(100)}::timestamptz, ${hoursFromNow(148)}::timestamptz) where booking_id = ${r.booking_id}`),
    );
    const c = await db.execute<{ j: { status: string; cancellable: boolean } }>(sql`select pub.cancel_booking(${r.token}) as j`);
    expect(c.rows[0]!.j).toMatchObject({ status: 'cancelled', cancellable: false });
    const items = await withTenant(db, { userId: b.owner, orgId: b.orgId }, (tx) => tx.execute<{ active: boolean }>(sql`select active from booking_items where booking_id = ${r.booking_id}`));
    expect(items.rows.every((i) => !i.active)).toBe(true);
  });

  it('รับรถภายใน 2 ชม. ยกเลิกเองไม่ได้', async () => {
    const r = await book(b, 1.5);
    await rejects(db.execute(sql`select pub.cancel_booking(${r.token})`), /booking_not_cancellable/);
  });

  it('API อ่านตาราง bookings ตรงๆ โดยไม่มี context ไม่ได้', async () => {
    const r = await db.execute(sql`select id from bookings`);
    expect(r.rows).toHaveLength(0);
  });
});
