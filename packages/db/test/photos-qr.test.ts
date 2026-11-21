// รูปหน้าปก + สติกเกอร์ QR (migration 0013): กฎที่ฐานข้อมูลบังคับเอง
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant, type Db, type Tx } from '../src/index.ts';

const APP_URL = process.env.DATABASE_APP_URL ?? 'postgres://rental_api:rental_api_dev@localhost:54330/rental';
const s = randomBytes(3).toString('hex');
let db: Db;

interface Shop {
  slug: string;
  orgId: string;
  owner: string;
  staff: string;
  typeId: string;
  assetId: string;
  otherAssetId: string;
  typeCover: string;
  assetCover: string;
  photo: string;
  token: string;
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
const one = async <T>(p: Promise<{ rows: T[] }>) => (await p).rows[0]!;
const as = <T>(sh: Shop, who: 'owner' | 'staff', fn: (tx: Tx) => Promise<T>) =>
  withTenant(db, { userId: who === 'owner' ? sh.owner : sh.staff, orgId: sh.orgId }, fn);

async function setupShop(tag: string): Promise<Shop> {
  const slug = `${tag}-${s}`;
  const o = await one<{ org_id: string; user_id: string }>(
    db.execute(sql`select * from auth.create_org(${slug}, ${tag}, ${`${tag}.o.${s}`}, 'o', null, 'h')`),
  );
  const token = randomBytes(8).toString('hex');
  await withTenant(db, { userId: o.user_id, orgId: o.org_id }, (tx) =>
    tx.execute(sql`insert into invitations (org_id, token_hash, username, display_name, role, invited_by, expires_at)
      values (${o.org_id}, ${token}, ${`${tag}.s.${s}`}, 's', 'staff', ${o.user_id}, now() + interval '1 day')`),
  );
  const st = await one<{ user_id: string }>(db.execute(sql`select * from auth.accept_invitation(${token}, 'h')`));
  const ids = await withTenant(db, { userId: o.user_id, orgId: o.org_id }, async (tx) => {
    const t = await one<{ id: string }>(
      tx.execute(sql`insert into asset_types (org_id, name, public_name, tracking, code_prefix, price_per_day) values (${o.org_id}, 'คลิก', 'Honda Click', 'unit', 'C-', 25000) returning id`),
    );
    const a1 = await one<{ id: string; qr_token: string }>(
      tx.execute(sql`insert into assets (org_id, asset_type_id, code, plate) values (${o.org_id}, ${t.id}, 'C-01', 'กข 1234') returning id, qr_token`),
    );
    const a2 = await one<{ id: string }>(tx.execute(sql`insert into assets (org_id, asset_type_id, code) values (${o.org_id}, ${t.id}, 'C-02') returning id`));
    const media = (kind: string, target: string) =>
      one<{ id: string }>(
        tx.execute(sql`insert into media (org_id, kind, asset_id, asset_type_id, storage_key, content_type, size_bytes, created_by)
          values (${o.org_id}, ${kind}, ${target === 'type' ? null : a1.id}, ${target === 'type' ? t.id : null},
                  ${`org/${o.org_id}/${kind}/${randomBytes(6).toString('hex')}.jpg`}, 'image/jpeg', 10, ${o.user_id}) returning id`),
      );
    const typeCover = await media('cover', 'type');
    const assetCover = await media('cover', 'asset');
    const photo = await one<{ id: string }>(
      tx.execute(sql`insert into media (org_id, kind, asset_id, storage_key, content_type, size_bytes, created_by)
        values (${o.org_id}, 'maintenance_receipt', ${a1.id}, ${`org/${o.org_id}/r/${randomBytes(6).toString('hex')}.jpg`}, 'image/jpeg', 10, ${o.user_id}) returning id`),
    );
    return { typeId: t.id, assetId: a1.id, otherAssetId: a2.id, token: a1.qr_token, typeCover: typeCover.id, assetCover: assetCover.id, photo: photo.id };
  });
  return { slug, orgId: o.org_id, owner: o.user_id, staff: st.user_id, ...ids };
}

let a: Shop;
let b: Shop;
beforeAll(async () => {
  db = createDb(APP_URL, 4);
  a = await setupShop('pa');
  b = await setupShop('pb');
});
afterAll(async () => {
  await db.$client.end();
});

describe('รูปหน้าปก', () => {
  it('ตั้งรูปหน้าปกของประเภท/คันด้วยรูปของตัวเองได้', async () => {
    await as(a, 'owner', async (tx) => {
      await tx.execute(sql`update asset_types set cover_media_id = ${a.typeCover} where id = ${a.typeId}`);
      await tx.execute(sql`update assets set cover_media_id = ${a.assetCover} where id = ${a.assetId}`);
    });
    const r = await as(a, 'staff', (tx) => one<{ c: string }>(tx.execute(sql`select cover_media_id as c from assets where id = ${a.assetId}`)));
    expect(r.c).toBe(a.assetCover);
  });

  it('ร้าน A ตั้งรูปของร้าน B เป็นหน้าปกไม่ได้', async () => {
    await rejects(as(a, 'owner', (tx) => tx.execute(sql`update asset_types set cover_media_id = ${b.typeCover} where id = ${a.typeId}`)), /cross_org_reference/);
    await rejects(as(a, 'owner', (tx) => tx.execute(sql`update assets set cover_media_id = ${b.assetCover} where id = ${a.otherAssetId}`)), /cross_org_reference/);
  });

  it('ใช้รูปที่ไม่ใช่ชนิด cover หรือรูปที่อัปโหลดให้เป้าหมายอื่นไม่ได้', async () => {
    await rejects(as(a, 'owner', (tx) => tx.execute(sql`update assets set cover_media_id = ${a.photo} where id = ${a.assetId}`)), /cross_org_reference/);
    // รูปของคัน C-01 ใช้กับคัน C-02 ไม่ได้ · รูปของประเภทใช้กับคันไม่ได้
    await rejects(as(a, 'owner', (tx) => tx.execute(sql`update assets set cover_media_id = ${a.assetCover} where id = ${a.otherAssetId}`)), /cross_org_reference/);
    await rejects(as(a, 'owner', (tx) => tx.execute(sql`update assets set cover_media_id = ${a.typeCover} where id = ${a.otherAssetId}`)), /cross_org_reference/);
  });

  it('รูปหน้าปกต้องผูกกับเป้าหมายเดียว · asset_type_id ใช้กับรูปหน้าปกเท่านั้น', async () => {
    const insert = (kind: string, assetId: string | null, typeId: string | null) =>
      as(a, 'owner', (tx) =>
        tx.execute(sql`insert into media (org_id, kind, asset_id, asset_type_id, storage_key, content_type, size_bytes, created_by)
          values (${a.orgId}, ${kind}, ${assetId}, ${typeId}, ${`k/${randomBytes(6).toString('hex')}`}, 'image/jpeg', 10, ${a.owner})`),
      );
    await rejects(insert('cover', null, null), /media_cover_target_check/);
    await rejects(insert('cover', a.assetId, a.typeId), /media_cover_target_check/);
    await rejects(insert('maintenance_receipt', a.assetId, a.typeId), /media_asset_type_only_cover/);
    // รูปหน้าปกของประเภทร้าน B ไม่ได้
    await rejects(insert('cover', null, b.typeId), /cross_org_reference/);
  });

  it('พนักงานเปลี่ยนรูปหน้าปกหรือ QR ของคันไม่ได้ · แก้ประเภทไม่มีผล (RLS)', async () => {
    await rejects(as(a, 'staff', (tx) => tx.execute(sql`update assets set cover_media_id = null where id = ${a.assetId}`)), /forbidden_field/);
    await rejects(as(a, 'staff', (tx) => tx.execute(sql`update assets set qr_token = 'x' where id = ${a.assetId}`)), /forbidden_field/);
    const r = await as(a, 'staff', (tx) => tx.execute(sql`update asset_types set cover_media_id = null where id = ${a.typeId}`));
    expect(r.rowCount).toBe(0);
  });
});

describe('สติกเกอร์ QR', () => {
  it('ทุกคันมี token สุ่ม 32 ตัว ไม่ซ้ำกัน', async () => {
    const rows = (await as(a, 'owner', (tx) => tx.execute<{ qr_token: string }>(sql`select qr_token from assets`))).rows;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.qr_token).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(rows.map((r) => r.qr_token)).size).toBe(rows.length);
  });

  it('ร้าน A มองไม่เห็น token ของร้าน B', async () => {
    const r = await as(a, 'owner', (tx) => tx.execute(sql`select id from assets where qr_token = ${b.token}`));
    expect(r.rows).toHaveLength(0);
  });

  it('pub.qr_lookup คืนเฉพาะข้อมูลร้าน/รหัสคัน (ไม่มีทะเบียน ลูกค้า org id)', async () => {
    const j = (await one<{ j: Record<string, unknown> }>(db.execute(sql`select pub.qr_lookup(${a.token}) as j`))).j;
    expect(Object.keys(j).sort()).toEqual(
      ['bookingEnabled', 'code', 'contactPhone', 'contactWhatsapp', 'coverMediaId', 'hasCover', 'shopName', 'shopSlug', 'typeId', 'typePublicName'].sort(),
    );
    expect(j).toMatchObject({ code: 'C-01', shopSlug: a.slug, typePublicName: 'Honda Click', hasCover: true, bookingEnabled: false });
    expect(JSON.stringify(j)).not.toContain('กข 1234');
    expect((await one<{ j: unknown }>(db.execute(sql`select pub.qr_lookup('0123456789abcdef0123456789abcdef') as j`))).j).toBeNull();
  });

  it('pub.type_cover คืนรูปเฉพาะร้านที่เปิดหน้าจอง และเฉพาะประเภทของร้านนั้น', async () => {
    // ร้านใหม่ปิดหน้าจองไว้ก่อน
    expect((await db.execute(sql`select * from pub.type_cover(${a.slug}, ${a.typeId}::uuid)`)).rows).toHaveLength(0);
    await as(a, 'owner', (tx) => tx.execute(sql`update org_settings set public_booking_enabled = true where org_id = ${a.orgId}`));
    const r = await one<{ media_id: string }>(db.execute(sql`select * from pub.type_cover(${a.slug}, ${a.typeId}::uuid)`));
    expect(r.media_id).toBe(a.typeCover);
    // slug ของร้าน A กับประเภทของร้าน B → ไม่มี
    expect((await db.execute(sql`select * from pub.type_cover(${a.slug}, ${b.typeId}::uuid)`)).rows).toHaveLength(0);
  });
});

describe('ช่องทางติดต่อร้าน', () => {
  it('เก็บได้เฉพาะตัวเลข 8–15 หลัก (มี + นำหน้าได้)', async () => {
    await as(a, 'owner', (tx) => tx.execute(sql`update org_settings set contact_whatsapp = '+66812345678', contact_phone = '0771234567' where org_id = ${a.orgId}`));
    await rejects(as(a, 'owner', (tx) => tx.execute(sql`update org_settings set contact_phone = '12-34' where org_id = ${a.orgId}`)), /org_settings_contact_check/);
    const j = (await one<{ j: Record<string, unknown> }>(db.execute(sql`select pub.qr_lookup(${a.token}) as j`))).j;
    expect(j).toMatchObject({ contactWhatsapp: '+66812345678', contactPhone: '0771234567', bookingEnabled: true });
  });
});
