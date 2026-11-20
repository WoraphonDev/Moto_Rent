// regression จากการตรวจความปลอดภัย (migration 0009)
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant, type Db } from '../src/index.ts';

const APP_URL = process.env.DATABASE_APP_URL ?? 'postgres://rental_api:rental_api_dev@localhost:54330/rental';
const s = randomBytes(3).toString('hex');
let db: Db;

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
const one = async <T>(p: Promise<{ rows: T[] }>) => (await p).rows[0]!;

interface Shop {
  orgId: string;
  owner: string;
  staff: string;
}

async function shop(tag: string): Promise<Shop> {
  const o = await one<{ org_id: string; user_id: string }>(
    db.execute(sql`select * from auth.create_org(${`${tag}-${s}`}, ${tag}, ${`${tag}.o.${s}`}, 'o', null, 'h')`),
  );
  const token = randomBytes(8).toString('hex');
  await withTenant(db, { userId: o.user_id, orgId: o.org_id }, (tx) =>
    tx.execute(sql`insert into invitations (org_id, token_hash, username, display_name, role, invited_by, expires_at)
      values (${o.org_id}, ${token}, ${`${tag}.s.${s}`}, 's', 'staff', ${o.user_id}, now() + interval '1 day')`),
  );
  const st = await one<{ user_id: string }>(db.execute(sql`select * from auth.accept_invitation(${token}, 'h')`));
  return { orgId: o.org_id, owner: o.user_id, staff: st.user_id };
}

let a: Shop;
let b: Shop;
beforeAll(async () => {
  db = createDb(APP_URL, 4);
  a = await shop('fa');
  b = await shop('fb');
});
afterAll(async () => {
  await db.$client.end();
});

describe('ตัวตนและลิงก์ตั้งรหัสใหม่', () => {
  it('เจ้าของร้าน A ออกลิงก์ตั้งรหัสใหม่ให้ผู้ใช้ของร้าน B ไม่ได้', async () => {
    await rejects(
      withTenant(db, { userId: a.owner, orgId: a.orgId }, (tx) =>
        tx.execute(sql`insert into invitations (org_id, token_hash, kind, user_id, username, display_name, role, invited_by, expires_at)
          values (${a.orgId}, ${randomBytes(8).toString('hex')}, 'reset', ${b.owner}, 'x', 'x', 'staff', ${a.owner}, now() + interval '1 day')`),
      ),
      /row-level security/,
    );
  });

  it('สร้างลิงก์เชิญเป็นเจ้าของร้านไม่ได้', async () => {
    await rejects(
      withTenant(db, { userId: a.owner, orgId: a.orgId }, (tx) =>
        tx.execute(sql`insert into invitations (org_id, token_hash, username, display_name, role, invited_by, expires_at)
          values (${a.orgId}, ${randomBytes(8).toString('hex')}, ${`own2.${s}`}, 'x', 'owner', ${a.owner}, now() + interval '1 day')`),
      ),
      /row-level security/,
    );
  });

  it('API เพิ่มสมาชิกเองไม่ได้ และแก้ user_id ของ session ไม่ได้', async () => {
    await rejects(
      withTenant(db, { userId: a.owner, orgId: a.orgId }, (tx) =>
        tx.execute(sql`insert into memberships (org_id, user_id, role) values (${a.orgId}, ${b.staff}, 'staff')`),
      ),
      /permission denied/,
    );
    await rejects(
      withTenant(db, { userId: a.owner, orgId: a.orgId }, (tx) => tx.execute(sql`update sessions set user_id = ${a.staff}`)),
      /permission denied/,
    );
  });

  it('ชื่อผู้ใช้เป็นตัวเลขล้วนไม่ได้', async () => {
    await rejects(db.execute(sql`select * from auth.create_org(${`fd-${s}`}, 'd', '0812345678', 'o', null, 'h')`), /users_username_has_letter/);
  });
});

describe('เงิน', () => {
  async function openBill(sh: Shop) {
    return withTenant(db, { userId: sh.staff, orgId: sh.orgId }, async (tx) => {
      const c = await one<{ id: string }>(tx.execute(sql`insert into customers (org_id, full_name) values (${sh.orgId}, ${`C ${randomUUID()}`}) returning id`));
      const bill = await one<{ id: string }>(tx.execute(sql`insert into bills (org_id, customer_id) values (${sh.orgId}, ${c.id}) returning id`));
      await tx.execute(sql`insert into bill_lines (org_id, bill_id, kind, description, amount, created_by) values (${sh.orgId}, ${bill.id}, 'rental', 'x', 100000, ${sh.staff})`);
      return bill.id;
    });
  }
  const discount = (sh: Shop, bill: string, amount: number) =>
    withTenant(db, { userId: sh.staff, orgId: sh.orgId }, (tx) =>
      tx.execute(sql`insert into bill_lines (org_id, bill_id, kind, description, amount, reason, created_by)
        values (${sh.orgId}, ${bill}, 'discount', 'ลด', ${-amount}, 'x', ${sh.staff})`),
    );

  it('พนักงานลดหลายครั้งรวมเกินเพดาน (฿100) ไม่ได้', async () => {
    const bill = await openBill(a);
    await discount(a, bill, 6_000);
    await rejects(discount(a, bill, 6_000), /discount_over_limit/);
    await discount(a, bill, 4_000);
  });

  it('ปิดยอดวันนี้แล้ว รับเงินเพิ่มในวันนี้ไม่ได้', async () => {
    const bill = await openBill(b);
    await withTenant(db, { userId: b.staff, orgId: b.orgId }, (tx) =>
      tx.execute(sql`insert into day_closes (org_id, business_date, expected_cash, counted_cash, closed_by)
        values (${b.orgId}, app.business_date(${b.orgId}, now()), 0, 0, ${b.staff})`),
    );
    await rejects(
      withTenant(db, { userId: b.staff, orgId: b.orgId }, (tx) =>
        tx.execute(sql`insert into payments (org_id, bill_id, method, amount, received_by) values (${b.orgId}, ${bill}, 'cash', 1000, ${b.staff})`),
      ),
      /day_closed/,
    );
  });
});
