// กฎเฟส 1 ที่ฐานข้อมูลบังคับเอง (ไม่พึ่ง API)
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant, type Db } from '../src/index.ts';

const APP_URL = process.env.DATABASE_APP_URL ?? 'postgres://rental_api:rental_api_dev@localhost:54330/rental';
const s = randomBytes(3).toString('hex');
let db: Db;

interface Shop {
  orgId: string;
  owner: string;
  staff: string;
  typeId: string;
  assetId: string;
  customerId: string;
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

const as = <T>(shop: Shop, who: 'owner' | 'staff', fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(db, { userId: who === 'owner' ? shop.owner : shop.staff, orgId: shop.orgId }, fn);

async function one<T>(p: Promise<{ rows: T[] }>): Promise<T> {
  return (await p).rows[0]!;
}

async function setupShop(tag: string): Promise<Shop> {
  const { org_id: orgId, user_id: owner } = await one<{ org_id: string; user_id: string }>(
    db.execute(sql`select * from auth.create_org(${`${tag}-${s}`}, ${tag}, ${`${tag}.o.${s}`}, 'o', null, 'h')`),
  );
  const token = randomBytes(8).toString('hex');
  await withTenant(db, { userId: owner, orgId }, (tx) =>
    tx.execute(sql`insert into invitations (org_id, token_hash, username, display_name, role, invited_by, expires_at)
      values (${orgId}, ${token}, ${`${tag}.s.${s}`}, 's', 'staff', ${owner}, now() + interval '1 day')`),
  );
  const { user_id: staff } = await one<{ user_id: string }>(db.execute(sql`select * from auth.accept_invitation(${token}, 'h')`));
  const ids = await withTenant(db, { userId: owner, orgId }, async (tx) => {
    const t = await one<{ id: string }>(
      tx.execute(sql`insert into asset_types (org_id, name, tracking, code_prefix, price_per_day) values (${orgId}, 'Click', 'unit', 'C-', 25000) returning id`),
    );
    const a = await one<{ id: string }>(
      tx.execute(sql`insert into assets (org_id, asset_type_id, code) values (${orgId}, ${t.id}, 'C-01') returning id`),
    );
    const c = await one<{ id: string }>(
      tx.execute(sql`insert into customers (org_id, full_name, hotel_room) values (${orgId}, 'Emma Larsen', '204') returning id`),
    );
    return { typeId: t.id, assetId: a.id, customerId: c.id };
  });
  return { orgId, owner, staff, ...ids };
}

async function rent(shop: Shop, who: 'owner' | 'staff' = 'staff') {
  const id = randomUUID();
  await as(shop, who, async (tx) => {
    await tx.execute(sql`insert into rentals (id, org_id, customer_id, start_at, due_at, created_by)
      values (${id}, ${shop.orgId}, ${shop.customerId}, now(), now() + interval '3 days', ${who === 'owner' ? shop.owner : shop.staff})`);
    await tx.execute(sql`insert into rental_items (org_id, rental_id, asset_type_id, asset_id, price_per_day)
      values (${shop.orgId}, ${id}, ${shop.typeId}, ${shop.assetId}, 25000)`);
  });
  return id;
}

async function openBill(shop: Shop) {
  return as(shop, 'staff', async (tx) =>
    (await one<{ id: string }>(tx.execute(sql`insert into bills (org_id, customer_id) values (${shop.orgId}, ${shop.customerId}) returning id`))).id,
  );
}

let a: Shop;
let b: Shop;

beforeAll(async () => {
  db = createDb(APP_URL, 4);
  a = await setupShop('ra');
  b = await setupShop('rb');
});
afterAll(async () => {
  await db.$client.end();
});

describe('ของรายชิ้นอยู่ในสัญญาที่ยังไม่คืนได้ใบเดียว', () => {
  it('ปล่อยรถคันเดียวกันซ้อนไม่ได้ แม้ส่งพร้อมกันจากสองเครื่อง', async () => {
    const results = await Promise.allSettled([rent(a), rent(a)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(failed.reason.cause?.message ?? failed.reason)).toMatch(/rental_items_one_active_per_asset/);
  });

  it('คืนแล้ว (released_at) ปล่อยต่อได้', async () => {
    await as(a, 'staff', (tx) => tx.execute(sql`update rental_items set released_at = now() where asset_id = ${a.assetId} and released_at is null`));
    await expect(rent(a)).resolves.toBeTruthy();
    await as(a, 'staff', (tx) => tx.execute(sql`update rental_items set released_at = now() where asset_id = ${a.assetId} and released_at is null`));
  });
});

describe('อ้างข้อมูลข้ามร้านไม่ได้', () => {
  it('สัญญาของร้าน A อ้างลูกค้าของร้าน B ไม่ได้', async () => {
    await rejects(
      as(a, 'staff', (tx) =>
        tx.execute(sql`insert into rentals (id, org_id, customer_id, start_at, due_at, created_by)
          values (${randomUUID()}, ${a.orgId}, ${b.customerId}, now(), now() + interval '1 day', ${a.staff})`),
      ),
      /cross_org_reference/,
    );
  });

  it('ใส่รถของร้าน B ในสัญญาร้าน A ไม่ได้', async () => {
    const id = randomUUID();
    await rejects(
      as(a, 'staff', async (tx) => {
        await tx.execute(sql`insert into rentals (id, org_id, customer_id, start_at, due_at, created_by)
          values (${id}, ${a.orgId}, ${a.customerId}, now(), now() + interval '1 day', ${a.staff})`);
        await tx.execute(sql`insert into rental_items (org_id, rental_id, asset_type_id, asset_id, price_per_day)
          values (${a.orgId}, ${id}, ${a.typeId}, ${b.assetId}, 1)`);
      }),
      /cross_org_reference/,
    );
  });
});

describe('สิทธิ์ของพนักงาน', () => {
  it('แก้เลขไมล์ได้ แต่แก้ราคารถไม่ได้', async () => {
    await as(a, 'staff', (tx) => tx.execute(sql`update assets set odometer = 12480 where id = ${a.assetId}`));
    await rejects(as(a, 'staff', (tx) => tx.execute(sql`update assets set price_per_day = 1 where id = ${a.assetId}`)), /forbidden_field/);
  });

  it('ติดธง "ไม่ให้เช่า" ไม่ได้ เจ้าของทำได้', async () => {
    await rejects(
      as(a, 'staff', (tx) => tx.execute(sql`update customers set do_not_rent = true, do_not_rent_reason = 'x' where id = ${a.customerId}`)),
      /forbidden_field/,
    );
    await as(a, 'owner', (tx) => tx.execute(sql`update customers set do_not_rent = true, do_not_rent_reason = 'ขับประมาท' where id = ${a.customerId}`));
    await as(a, 'owner', (tx) => tx.execute(sql`update customers set do_not_rent = false, do_not_rent_reason = null where id = ${a.customerId}`));
  });

  it('ยกเลิกสัญญาไม่ได้ เจ้าของทำได้', async () => {
    const id = await rent(a);
    await rejects(as(a, 'staff', (tx) => tx.execute(sql`update rentals set status = 'cancelled' where id = ${id}`)), /owner_only/);
    await as(a, 'owner', async (tx) => {
      await tx.execute(sql`update rentals set status = 'cancelled' where id = ${id}`);
      await tx.execute(sql`update rental_items set released_at = now() where rental_id = ${id}`);
    });
  });
});

describe('เงิน', () => {
  it('ส่วนลดเกินเพดาน (฿100) ถูกปฏิเสธ · ในเพดานผ่าน · เจ้าของไม่มีเพดาน', async () => {
    const bill = await openBill(a);
    const line = (who: 'owner' | 'staff', amount: number) =>
      as(a, who, (tx) =>
        tx.execute(sql`insert into bill_lines (org_id, bill_id, kind, description, amount, reason, created_by)
          values (${a.orgId}, ${bill}, 'discount', 'ส่วนลด', ${amount}, 'ลูกค้าประจำ', ${who === 'owner' ? a.owner : a.staff})`),
      );
    await expect(line('staff', -10_000)).resolves.toBeTruthy();
    await rejects(line('staff', -10_001), /discount_over_limit/);
    await expect(line('owner', -50_000)).resolves.toBeTruthy();
    await as(a, 'owner', (tx) => tx.execute(sql`update bills set status = 'void', voided_at = now(), void_reason = 'test' where id = ${bill}`));
  });

  it('รายการบิลและการรับเงินแก้หรือลบไม่ได้', async () => {
    const bill = await openBill(a);
    await as(a, 'staff', (tx) =>
      tx.execute(sql`insert into bill_lines (org_id, bill_id, kind, description, amount, created_by) values (${a.orgId}, ${bill}, 'rental', 'Click 3 วัน', 75000, ${a.staff})`),
    );
    await rejects(as(a, 'staff', (tx) => tx.execute(sql`update bill_lines set amount = 1 where bill_id = ${bill}`)), /permission denied/);
    await rejects(as(a, 'owner', (tx) => tx.execute(sql`delete from bill_lines where bill_id = ${bill}`)), /permission denied/);
    await as(a, 'staff', (tx) =>
      tx.execute(sql`insert into payments (org_id, bill_id, method, amount, received_by) values (${a.orgId}, ${bill}, 'cash', 75000, ${a.staff})`),
    );
    await rejects(as(a, 'owner', (tx) => tx.execute(sql`delete from payments where bill_id = ${bill}`)), /permission denied/);
    await as(a, 'staff', (tx) => tx.execute(sql`update bills set status = 'paid', paid_at = now() where id = ${bill}`));
  });

  it('บิลที่จ่ายแล้ว: เพิ่มรายการ รับเงิน หรือเปิดใหม่ไม่ได้ · พนักงานยกเลิกไม่ได้', async () => {
    const [bill] = (await as(a, 'staff', (tx) => tx.execute<{ id: string }>(sql`select id from bills where status = 'paid' limit 1`))).rows;
    await rejects(
      as(a, 'staff', (tx) =>
        tx.execute(sql`insert into payments (org_id, bill_id, method, amount, received_by) values (${a.orgId}, ${bill!.id}, 'cash', 1, ${a.staff})`),
      ),
      /bill_closed/,
    );
    await rejects(as(a, 'staff', (tx) => tx.execute(sql`update bills set status = 'open' where id = ${bill!.id}`)), /bill_closed/);
    await rejects(as(a, 'staff', (tx) => tx.execute(sql`update bills set status = 'void' where id = ${bill!.id}`)), /owner_only/);
  });

  it('ลูกค้า 1 คนมีบิลเปิดได้ใบเดียว', async () => {
    await openBill(a);
    await rejects(openBill(a), /bills_one_open_per_customer/);
  });

  it('เลขใบเสร็จเพิ่มทีละ 1 แยกต่อร้าน', async () => {
    const next = (shop: Shop) => as(shop, 'staff', async (tx) => Number((await one<{ v: string }>(tx.execute(sql`select app.next_counter('receipt') as v`))).v));
    const a1 = await next(a);
    const a2 = await next(a);
    const b1 = await next(b);
    expect(a2).toBe(a1 + 1);
    expect(b1).toBe(1);
  });
});
