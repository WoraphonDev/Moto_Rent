// เทสต์ว่าการแยกข้อมูลระหว่างร้านถูกบังคับที่ฐานข้อมูล (ไม่ใช่แค่ใน API)
// ใช้บัญชีของ API (rental_api) ที่อยู่ใต้ RLS · ต้องรัน `pnpm db:setup` ก่อน
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant, type Db } from '../src/index.ts';

const APP_URL = process.env.DATABASE_APP_URL ?? 'postgres://rental_api:rental_api_dev@localhost:54330/rental';
const suffix = randomBytes(3).toString('hex');
let db: Db;

interface Org {
  orgId: string;
  ownerId: string;
}

async function createOrg(tag: string): Promise<Org> {
  const r = await db.execute<{ user_id: string; org_id: string }>(
    sql`select * from auth.create_org(${`${tag}-${suffix}`}, ${`Shop ${tag}`}, ${`${tag}.owner.${suffix}`}, ${'Owner'}, ${null}, ${'hash'})`,
  );
  const row = r.rows[0]!;
  return { orgId: row.org_id, ownerId: row.user_id };
}

async function invite(org: Org, username: string, role: string, kind = 'invite', userId: string | null = null) {
  const token = randomBytes(8).toString('hex');
  await withTenant(db, { userId: org.ownerId, orgId: org.orgId }, (tx) =>
    tx.execute(sql`insert into invitations (org_id, token_hash, kind, user_id, username, display_name, role, invited_by, expires_at)
      values (${org.orgId}, ${token}, ${kind}, ${userId}, ${username}, ${username}, ${role}, ${org.ownerId}, now() + interval '1 day')`),
  );
  return token;
}

const count = (r: { rows: unknown[] }) => r.rows.length;

/** drizzle ห่อ error ของ pg ไว้ใน cause · ตรวจข้อความจริงจาก Postgres */
async function rejectsWith(p: Promise<unknown>, pattern: RegExp) {
  try {
    await p;
  } catch (e) {
    const err = e as { message: string; cause?: { message?: string } };
    expect(err.cause?.message ?? err.message).toMatch(pattern);
    return;
  }
  throw new Error(`expected rejection matching ${pattern}`);
}

let a: Org;
let b: Org;
let staffA: string;

beforeAll(async () => {
  db = createDb(APP_URL, 4);
  a = await createOrg('a');
  b = await createOrg('b');
  const t = await invite(a, `nok.${suffix}`, 'staff');
  const r = await db.execute<{ user_id: string }>(sql`select * from auth.accept_invitation(${t}, ${'hash2'})`);
  staffA = r.rows[0]!.user_id;
});

afterAll(async () => {
  await db.$client.end();
});

describe('แยกข้อมูลระหว่างร้าน', () => {
  it('ไม่ตั้งร้าน = ไม่เห็นข้อมูลร้านใดเลย', async () => {
    const r = await withTenant(db, { userId: null, orgId: null }, (tx) => tx.execute(sql`select id from branches`));
    expect(count(r)).toBe(0);
  });

  it('เจ้าของร้าน A เห็นเฉพาะสาขาของร้าน A', async () => {
    const r = await withTenant(db, { userId: a.ownerId, orgId: a.orgId }, (tx) =>
      tx.execute<{ org_id: string }>(sql`select org_id from branches`),
    );
    expect(r.rows.map((x) => x.org_id)).toEqual([a.orgId]);
  });

  it('ตั้ง org_id เป็นร้านอื่นที่ตัวเองไม่ได้เป็นสมาชิก = ไม่เห็นอะไร', async () => {
    const r = await withTenant(db, { userId: a.ownerId, orgId: b.orgId }, (tx) => tx.execute(sql`select id from branches`));
    expect(count(r)).toBe(0);
  });

  it('เขียนข้อมูลลงร้านอื่นไม่ได้', async () => {
    await rejectsWith(
      withTenant(db, { userId: a.ownerId, orgId: a.orgId }, (tx) =>
        tx.execute(sql`insert into branches (org_id, name) values (${b.orgId}, 'แอบเพิ่ม')`),
      ),
      /row-level security/,
    );
  });

  it('เห็นเพื่อนร่วมร้านปัจจุบัน แต่ไม่เห็นผู้ใช้ร้านอื่น', async () => {
    const r = await withTenant(db, { userId: a.ownerId, orgId: a.orgId }, (tx) =>
      tx.execute<{ id: string }>(sql`select id from users`),
    );
    const ids = r.rows.map((x) => x.id).sort();
    expect(ids).toEqual([a.ownerId, staffA].sort());
    expect(ids).not.toContain(b.ownerId);
  });

  it('อ่าน password_hash ไม่ได้แม้เป็นข้อมูลของตัวเอง', async () => {
    await rejectsWith(
      withTenant(db, { userId: a.ownerId, orgId: a.orgId }, (tx) =>
        tx.execute(sql`select password_hash from users where id = ${a.ownerId}`),
      ),
      /permission denied/,
    );
  });
});

describe('สิทธิ์ตามบทบาท', () => {
  it('พนักงานแก้กฎของร้านไม่ได้ เจ้าของแก้ได้', async () => {
    const asStaff = await withTenant(db, { userId: staffA, orgId: a.orgId }, (tx) =>
      tx.execute(sql`update org_settings set staff_discount_cap = 999999 where org_id = ${a.orgId} returning org_id`),
    );
    expect(count(asStaff)).toBe(0);
    const asOwner = await withTenant(db, { userId: a.ownerId, orgId: a.orgId }, (tx) =>
      tx.execute(sql`update org_settings set staff_discount_cap = 20000 where org_id = ${a.orgId} returning org_id`),
    );
    expect(count(asOwner)).toBe(1);
  });

  it('พนักงานสร้างลิงก์เชิญไม่ได้', async () => {
    await rejectsWith(
      withTenant(db, { userId: staffA, orgId: a.orgId }, (tx) =>
        tx.execute(sql`insert into invitations (org_id, token_hash, username, display_name, role, invited_by, expires_at)
          values (${a.orgId}, 'x', 'evil', 'evil', 'owner', ${staffA}, now() + interval '1 day')`),
      ),
      /row-level security/,
    );
  });

  it('เจ้าของลดบทบาทหรือปิดบัญชีตัวเองไม่ได้ (กันร้านไม่เหลือเจ้าของ)', async () => {
    await rejectsWith(
      withTenant(db, { userId: a.ownerId, orgId: a.orgId }, (tx) =>
        tx.execute(sql`update memberships set role = 'staff' where org_id = ${a.orgId} and user_id = ${a.ownerId}`),
      ),
      /row-level security/,
    );
  });

  it('พนักงานขอเพิ่มเครื่องได้ แต่อนุมัติเองไม่ได้', async () => {
    const id = await withTenant(db, { userId: staffA, orgId: a.orgId }, async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`insert into devices (org_id, secret_hash, name, approval_code, requested_by)
        values (${a.orgId}, ${'s-' + suffix}, 'มือถือ Nok', '4F7K', ${staffA}) returning id`);
      return r.rows[0]!.id;
    });
    const approve = await withTenant(db, { userId: staffA, orgId: a.orgId }, (tx) =>
      tx.execute(sql`update devices set status = 'approved' where id = ${id} returning id`),
    );
    expect(count(approve)).toBe(0);
    const byOwner = await withTenant(db, { userId: a.ownerId, orgId: a.orgId }, (tx) =>
      tx.execute(sql`update devices set status = 'approved', approved_by = ${a.ownerId} where id = ${id} returning id`),
    );
    expect(count(byOwner)).toBe(1);
  });
});

describe('ประวัติการใช้งาน', () => {
  it('เขียนในนามคนอื่นไม่ได้', async () => {
    await rejectsWith(
      withTenant(db, { userId: staffA, orgId: a.orgId }, (tx) =>
        tx.execute(sql`insert into audit_log (org_id, actor_user_id, action, entity_type) values (${a.orgId}, ${a.ownerId}, 'x', 'x')`),
      ),
      /row-level security/,
    );
  });

  it('พนักงานอ่านประวัติไม่ได้ เจ้าของอ่านได้', async () => {
    const s = await withTenant(db, { userId: staffA, orgId: a.orgId }, (tx) => tx.execute(sql`select id from audit_log`));
    expect(count(s)).toBe(0);
    const o = await withTenant(db, { userId: a.ownerId, orgId: a.orgId }, (tx) => tx.execute(sql`select id from audit_log`));
    expect(count(o)).toBeGreaterThan(0);
  });

  it('ลบหรือแก้ไม่ได้ แม้เป็นเจ้าของร้าน', async () => {
    await rejectsWith(
      withTenant(db, { userId: a.ownerId, orgId: a.orgId }, (tx) => tx.execute(sql`delete from audit_log`)),
      /permission denied/,
    );
    await rejectsWith(
      withTenant(db, { userId: a.ownerId, orgId: a.orgId }, (tx) => tx.execute(sql`update audit_log set reason = 'x'`)),
      /permission denied/,
    );
  });
});

describe('ลิงก์เชิญและการเข้าระบบ', () => {
  it('ลิงก์เชิญใช้ได้ครั้งเดียว', async () => {
    const t = await invite(a, `ball.${suffix}`, 'staff');
    await db.execute(sql`select * from auth.accept_invitation(${t}, ${'h'})`);
    await rejectsWith(
      db.execute(sql`select * from auth.accept_invitation(${t}, ${'h'})`),
      /invitation_invalid/,
    );
  });

  it('ลิงก์ตั้งรหัสใหม่เปลี่ยนรหัสและไม่สร้างผู้ใช้ซ้ำ', async () => {
    const t = await invite(a, `nok.${suffix}`, 'staff', 'reset', staffA);
    const r = await db.execute<{ user_id: string }>(sql`select * from auth.accept_invitation(${t}, ${'new-hash'})`);
    expect(r.rows[0]!.user_id).toBe(staffA);
    const login = await db.execute<{ password_hash: string }>(sql`select * from auth.find_login(${`NOK.${suffix}`})`);
    expect(login.rows[0]!.password_hash).toBe('new-hash');
  });

  it('ผิดครบ 5 ครั้งล็อกบัญชี', async () => {
    let last: { out_failed_logins: number; out_locked_until: string | null } | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await db.execute<{ out_failed_logins: number; out_locked_until: string | null }>(
        sql`select * from auth.record_login_failure(${staffA}, 5, 15)`,
      );
      last = r.rows[0];
      if (i < 4) expect(last!.out_locked_until).toBeNull();
    }
    expect(last!.out_failed_logins).toBe(5);
    expect(last!.out_locked_until).not.toBeNull();
    await db.execute(sql`select auth.record_login_success(${staffA})`);
  });

  it('API อ่านตาราง users ตรงๆ โดยไม่มี context ไม่ได้', async () => {
    const r = await db.execute(sql`select id from users`);
    expect(count(r)).toBe(0);
  });
});
