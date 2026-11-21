import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { lateFee } from '@rental/core';
import { assets, assetTypes, assetVariants, bookingItems, bookings, customers, media, rentalItems, rentals, users, withTenant, type Db, type Tx } from '@rental/db';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../common/audit.js';
import { dbCall } from '../common/db-errors.js';
import { AppError, parse } from '../common/http.js';
import { DB } from '../infra.js';
import { Auth, Roles, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';
import { retireCover } from '../p1/media.controller.js';
import { lockAssets, settingsOf } from './billing.js';

const money = z.number().int().min(0).max(100_000_000);

const typeBody = z.object({
  name: z.string().trim().min(1).max(60),
  publicName: z.string().trim().max(60).nullable().optional().transform((v) => (v ? v : v === undefined ? undefined : null)),
  tracking: z.enum(['unit', 'quantity']),
  codePrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,4}-?$/)
    .optional(),
  pricePerDay: money,
  deposit: money.nullable().optional(),
});
const typePatch = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  publicName: z.string().trim().max(60).nullable().optional().transform((v) => (v ? v : v === undefined ? undefined : null)),
  pricePerDay: money.optional(),
  deposit: money.nullable().optional(),
  listedOnMarketplace: z.boolean().optional(),
  archived: z.boolean().optional(),
  /** เอารูปหน้าปกออกได้อย่างเดียว · ตั้งรูปใหม่ผ่าน POST /v1/media (kind = cover) */
  coverMediaId: z.null().optional(),
});
const variantBody = z.object({ label: z.string().trim().min(1).max(20), quantity: z.number().int().min(0).max(100_000) });
const assetBody = z.object({
  assetTypeId: z.string().uuid(),
  code: z.string().trim().toUpperCase().max(12).optional(),
  model: z.string().trim().max(60).optional(),
  plate: z.string().trim().max(20).optional(),
  color: z.string().trim().max(30).optional(),
  odometer: z.number().int().min(0).optional(),
  pricePerDay: money.nullable().optional(),
});
const assetPatch = z.object({
  status: z.enum(['available', 'maintenance', 'retired']).optional(),
  odometer: z.number().int().min(0).optional(),
  model: z.string().trim().max(60).optional(),
  plate: z.string().trim().max(20).optional(),
  color: z.string().trim().max(30).optional(),
  pricePerDay: money.nullable().optional(),
  notes: z.string().trim().max(500).optional(),
  /** เอารูปหน้าปกเฉพาะคันออก (กลับไปใช้รูปของประเภท) · เจ้าของ/ผู้จัดการ */
  coverMediaId: z.null().optional(),
});
const qrToken = z.string().regex(/^[0-9a-f]{32}$/);

/** สถานะที่กระดานรถแสดง · "ถูกเช่า/เลยกำหนด" ดูจากสัญญาที่ยังไม่คืน */
function boardState(status: string, rentalDue: Date | null | undefined, now = Date.now()) {
  if (rentalDue) return rentalDue.getTime() < now ? 'overdue' : 'rented';
  return status === 'maintenance' ? 'maintenance' : status === 'retired' ? 'retired' : 'available';
}

/** ประเภทของให้เช่า + ของรายชิ้น + ไซส์ (mock 1.08, 1.11, 6.W3) */
@Controller('v1')
@UseGuards(SessionGuard)
export class AssetsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('asset-types')
  async types(@Auth() a: AuthCtx) {
    return withTenant(this.db, a, async (tx) => {
      const types = await tx.select().from(assetTypes).where(isNull(assetTypes.archivedAt)).orderBy(asc(assetTypes.sortOrder), asc(assetTypes.createdAt));
      const variants = await tx.select().from(assetVariants).orderBy(asc(assetVariants.createdAt));
      // จำนวนที่ออกไปแล้วต่อไซส์ (ของนับจำนวน)
      const out = await tx
        .select({ variantId: rentalItems.variantId, out: sql<number>`sum(${rentalItems.quantity})::int` })
        .from(rentalItems)
        .where(and(isNull(rentalItems.releasedAt), sql`${rentalItems.variantId} is not null`))
        .groupBy(rentalItems.variantId);
      const outBy = new Map(out.map((o) => [o.variantId, o.out]));
      const unitCounts = await tx
        .select({ typeId: assets.assetTypeId, n: sql<number>`count(*)::int` })
        .from(assets)
        .where(sql`${assets.status} <> 'retired'`)
        .groupBy(assets.assetTypeId);
      const countBy = new Map(unitCounts.map((u) => [u.typeId, u.n]));
      return types.map((t) => ({
        ...t,
        unitCount: countBy.get(t.id) ?? 0,
        variants: variants
          .filter((v) => v.assetTypeId === t.id)
          .map((v) => ({ id: v.id, label: v.label, quantity: v.quantity, out: outBy.get(v.id) ?? 0, available: v.quantity - (outBy.get(v.id) ?? 0) })),
      }));
    });
  }

  @Post('asset-types')
  @Roles('owner', 'manager')
  async createType(@Auth() a: AuthCtx, @Body() body: unknown) {
    const input = parse(typeBody, body);
    if (input.tracking === 'unit' && !input.codePrefix) throw new AppError(HttpStatus.BAD_REQUEST, 'code_prefix_required');
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [row] = await tx
          .insert(assetTypes)
          .values({ orgId: a.orgId, name: input.name, publicName: input.publicName ?? null, tracking: input.tracking, codePrefix: input.codePrefix ?? null, pricePerDay: input.pricePerDay, deposit: input.deposit ?? null })
          .returning();
        await audit(tx, a, { action: 'asset_type.created', entityType: 'asset_type', entityId: row!.id, after: input });
        return row;
      }),
    );
  }

  @Patch('asset-types/:id')
  @Roles('owner', 'manager')
  async patchType(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(typePatch, body);
    if (!Object.keys(input).length) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_input');
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [before] = await tx.select().from(assetTypes).where(eq(assetTypes.id, id));
        if (!before) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        const { archived, coverMediaId, ...rest } = input;
        const [row] = await tx
          .update(assetTypes)
          .set({ ...rest, ...(coverMediaId === null ? { coverMediaId: null } : {}), ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }) })
          .where(eq(assetTypes.id, id))
          .returning();
        if (coverMediaId === null && before.coverMediaId) {
          await retireCover(tx, before.coverMediaId);
          await audit(tx, a, { action: 'asset_type.cover_removed', entityType: 'asset_type', entityId: id, before: { coverMediaId: before.coverMediaId } });
        }
        if (Object.keys(rest).length || archived !== undefined) await audit(tx, a, {
          action: input.pricePerDay !== undefined && input.pricePerDay !== before.pricePerDay ? 'asset_type.price_changed' : 'asset_type.updated',
          entityType: 'asset_type',
          entityId: id,
          before: { name: before.name, publicName: before.publicName, pricePerDay: before.pricePerDay, deposit: before.deposit, listedOnMarketplace: before.listedOnMarketplace },
          after: { ...rest, archived },
        });
        return row;
      }),
    );
  }

  @Post('asset-types/:id/variants')
  @Roles('owner', 'manager')
  async addVariant(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(variantBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [t] = await tx.select({ tracking: assetTypes.tracking }).from(assetTypes).where(eq(assetTypes.id, id));
        if (!t) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        if (t.tracking !== 'quantity') throw new AppError(HttpStatus.BAD_REQUEST, 'type_not_quantity');
        const [row] = await tx.insert(assetVariants).values({ orgId: a.orgId, assetTypeId: id, ...input }).returning();
        await audit(tx, a, { action: 'asset_variant.created', entityType: 'asset_variant', entityId: row!.id, after: input });
        return row;
      }),
    );
  }

  @Patch('asset-variants/:id')
  @Roles('owner', 'manager')
  async patchVariant(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    // แก้ได้เฉพาะชื่อไซส์ · เปลี่ยนจำนวนต้องผ่าน POST /v1/asset-variants/:id/adjust (บังคับเหตุผล + เก็บประวัติ)
    const input = parse(z.object({ label: variantBody.shape.label }), body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [before] = await tx.select().from(assetVariants).where(eq(assetVariants.id, id));
        if (!before) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        const [row] = await tx.update(assetVariants).set(input).where(eq(assetVariants.id, id)).returning();
        await audit(tx, a, { action: 'asset_variant.updated', entityType: 'asset_variant', entityId: id, before: { label: before.label, quantity: before.quantity }, after: input });
        return row;
      }),
    );
  }

  /** กระดานรถ: ของรายชิ้นทุกชิ้น + ใครเช่าอยู่ + เลยกำหนดไหม */
  @Get('assets')
  async list(@Auth() a: AuthCtx) {
    return withTenant(this.db, a, async (tx) => {
      const rows = await tx
        .select({
          id: assets.id,
          code: assets.code,
          model: assets.model,
          plate: assets.plate,
          color: assets.color,
          odometer: assets.odometer,
          status: assets.status,
          pricePerDay: sql<number>`coalesce(${assets.pricePerDay}, ${assetTypes.pricePerDay})`.mapWith(Number),
          assetTypeId: assets.assetTypeId,
          typeName: assetTypes.name,
          coverMediaId: sql<string | null>`coalesce(${assets.coverMediaId}, ${assetTypes.coverMediaId})`,
          ownCover: sql<boolean>`${assets.coverMediaId} is not null`,
          qrToken: assets.qrToken,
          rentalId: rentals.id,
          dueAt: rentals.dueAt,
          customerName: customers.fullName,
          hotelRoom: customers.hotelRoom,
        })
        .from(assets)
        .innerJoin(assetTypes, eq(assetTypes.id, assets.assetTypeId))
        .leftJoin(rentalItems, and(eq(rentalItems.assetId, assets.id), isNull(rentalItems.releasedAt)))
        .leftJoin(rentals, eq(rentals.id, rentalItems.rentalId))
        .leftJoin(customers, eq(customers.id, rentals.customerId))
        .where(sql`${assets.status} <> 'retired'`)
        .orderBy(asc(assetTypes.sortOrder), asc(assetTypes.createdAt), asc(assets.code));
      const now = Date.now();
      return rows.map((r) => ({ ...r, state: boardState(r.status, r.rentalId ? r.dueAt : null, now) }));
    });
  }

  @Post('assets')
  @Roles('owner', 'manager')
  async create(@Auth() a: AuthCtx, @Body() body: unknown) {
    const input = parse(assetBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [t] = await tx.select().from(assetTypes).where(eq(assetTypes.id, input.assetTypeId));
        if (!t) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        if (t.tracking !== 'unit') throw new AppError(HttpStatus.BAD_REQUEST, 'type_not_unit');
        const code = input.code ?? (await nextCode(tx, t.id, t.codePrefix ?? ''));
        const [row] = await tx
          .insert(assets)
          .values({ orgId: a.orgId, assetTypeId: t.id, code, model: input.model, plate: input.plate, color: input.color, odometer: input.odometer, pricePerDay: input.pricePerDay ?? null })
          .returning();
        await audit(tx, a, { action: 'asset.created', entityType: 'asset', entityId: row!.id, after: { ...input, code } });
        return row;
      }),
    );
  }

  @Patch('assets/:id')
  async patch(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(assetPatch, body);
    if (!Object.keys(input).length) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_input');
    if (input.coverMediaId !== undefined && a.role !== 'owner' && a.role !== 'manager') throw new AppError(HttpStatus.FORBIDDEN, 'forbidden');
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        // ล็อกคันนี้ก่อน (เดียวกับปล่อยเช่า/ยืนยันคำขอจอง) · ไม่ให้เปลี่ยนสถานะระหว่างมีคนกำลังปล่อยเช่า
        await lockAssets(tx, [id]);
        const [before] = await tx.select().from(assets).where(eq(assets.id, id));
        if (!before) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        if (input.status && input.status !== 'available' && input.status !== before.status) {
          const [inUse] = await tx
            .select({ id: rentalItems.id })
            .from(rentalItems)
            .where(and(eq(rentalItems.assetId, id), isNull(rentalItems.releasedAt)))
            .limit(1);
          if (inUse) throw new AppError(HttpStatus.CONFLICT, 'asset_in_use');
          if (input.status === 'retired') {
            const booked = await tx.execute<{ code: string }>(sql`
              select b.code from booking_items bi join bookings b on b.id = bi.booking_id
              where bi.asset_id = ${id} and bi.active and upper(bi.during) > now() limit 1`);
            const bk = booked.rows[0];
            if (bk) throw new AppError(HttpStatus.CONFLICT, 'asset_booked', { bookingCode: bk.code });
          }
        }
        const { coverMediaId, ...rest } = input;
        const [row] = await tx
          .update(assets)
          .set({ ...rest, ...(coverMediaId === null ? { coverMediaId: null } : {}) })
          .where(eq(assets.id, id))
          .returning();
        if (coverMediaId === null && before.coverMediaId) {
          await retireCover(tx, before.coverMediaId);
          await audit(tx, a, { action: 'asset.cover_removed', entityType: 'asset', entityId: id, before: { coverMediaId: before.coverMediaId } });
        }
        if (Object.keys(rest).length) {
          await audit(tx, a, {
            action: 'asset.updated',
            entityType: 'asset',
            entityId: id,
            before: { status: before.status, odometer: before.odometer, pricePerDay: before.pricePerDay },
            after: rest,
          });
        }
        return row;
      }),
    );
  }

  /** หา "คัน" จาก QR บนสติกเกอร์ (พนักงานสแกน) · token ของร้านอื่นมองไม่เห็นใต้ RLS → 404 */
  @Get('assets/by-qr/:token')
  async byQr(@Auth() a: AuthCtx, @Param('token') token: string) {
    const t = qrToken.safeParse(token);
    if (!t.success) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
    return withTenant(this.db, a, async (tx) => {
      const [row] = await tx.select({ assetId: assets.id, code: assets.code }).from(assets).where(eq(assets.qrToken, t.data));
      if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
      return row;
    });
  }

  /** ออก QR ใหม่ (สติกเกอร์หาย/ถูกแกะ) · token เดิมใช้ไม่ได้ทันที */
  @Post('assets/:id/qr-token/rotate')
  @HttpCode(200)
  @Roles('owner', 'manager')
  async rotateQr(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string) {
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [row] = await tx
          .update(assets)
          .set({ qrToken: sql`replace(gen_random_uuid()::text, '-', '')` })
          .where(eq(assets.id, id))
          .returning({ id: assets.id, code: assets.code, qrToken: assets.qrToken });
        if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        // ไม่เก็บ token ในประวัติ (ใครอ่านประวัติได้ก็จะได้ลิงก์ของสติกเกอร์ไปด้วย)
        await audit(tx, a, { action: 'asset.qr_rotated', entityType: 'asset', entityId: id, after: { code: row.code } });
        return { assetId: row.id, code: row.code, qrToken: row.qrToken };
      }),
    );
  }

  /** ป๊อปอัปรายละเอียดรถ 1 คัน (canvas หน้า 9) */
  @Get('assets/:id/detail')
  async detail(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string) {
    return withTenant(this.db, a, async (tx) => {
      const [row] = await tx
        .select({ asset: assets, type: assetTypes })
        .from(assets)
        .innerJoin(assetTypes, eq(assetTypes.id, assets.assetTypeId))
        .where(eq(assets.id, id));
      if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
      const { asset: x, type: t } = row;

      // สัญญาที่คันนี้อยู่ตอนนี้ (ยังไม่คืน)
      const [cur] = await tx
        .select({ id: rentals.id, startAt: rentals.startAt, dueAt: rentals.dueAt, customerName: customers.fullName, room: customers.hotelRoom, pricePerDay: rentalItems.pricePerDay })
        .from(rentalItems)
        .innerJoin(rentals, eq(rentals.id, rentalItems.rentalId))
        .innerJoin(customers, eq(customers.id, rentals.customerId))
        .where(and(eq(rentalItems.assetId, id), isNull(rentalItems.releasedAt)))
        .limit(1);
      let currentRental = null;
      if (cur) {
        const s = await settingsOf(tx, a.orgId);
        const fee = lateFee({ perDay: cur.pricePerDay, maxDays: null }, cur.dueAt, new Date(), { graceMinutes: s.lateGraceMinutes, halfDayUntilMinutes: s.lateHalfDayUntilMinutes });
        currentRental = { id: cur.id, customerName: cur.customerName, room: cur.room, startAt: cur.startAt, dueAt: cur.dueAt, lateFeeSoFar: fee };
      }

      // คำขอจองที่ยืนยันแล้วและกำหนดคันนี้ไว้ (ครั้งถัดไป)
      const [next] = await tx
        .select({ id: bookings.id, code: bookings.code, pickupAt: bookings.pickupAt, fullName: bookings.fullName })
        .from(bookingItems)
        .innerJoin(bookings, eq(bookings.id, bookingItems.bookingId))
        .where(and(eq(bookingItems.assetId, id), eq(bookingItems.active, true), sql`upper(booking_items.during) > now()`))
        .orderBy(asc(bookings.pickupAt))
        .limit(1);

      // สัญญาล่าสุดของคันนี้ (ใช้ทั้งประวัติ + รูปตอนรับคืนครั้งล่าสุด + ค่าเสียหาย)
      const history = await tx
        .select({
          rentalId: rentals.id,
          customerName: customers.fullName,
          startAt: rentals.startAt,
          returnedAt: rentals.returnedAt,
          status: rentals.status,
          lateFee: sql<number>`(select coalesce(sum(l.amount), 0) from bill_lines l where l.rental_id = ${rentals.id} and l.kind = 'late_fee')`.mapWith(Number),
        })
        .from(rentalItems)
        .innerJoin(rentals, eq(rentals.id, rentalItems.rentalId))
        .innerJoin(customers, eq(customers.id, rentals.customerId))
        .where(eq(rentalItems.assetId, id))
        .orderBy(desc(rentals.startAt))
        .limit(3);

      const [lastReturn] = await tx
        .select({ rentalId: rentals.id, returnedAt: rentals.returnedAt, by: users.displayName })
        .from(rentalItems)
        .innerJoin(rentals, eq(rentals.id, rentalItems.rentalId))
        .leftJoin(users, eq(users.id, rentals.returnedBy))
        .where(and(eq(rentalItems.assetId, id), eq(rentals.status, 'returned')))
        .orderBy(desc(rentals.returnedAt))
        .limit(1);
      const lastReturnPhotos = lastReturn
        ? (
            await tx
              .select({ mediaId: media.id, slot: media.slot, takenAt: media.createdAt, takenByName: users.displayName })
              .from(media)
              .innerJoin(users, eq(users.id, media.createdBy))
              .where(
                and(
                  eq(media.rentalId, lastReturn.rentalId),
                  eq(media.kind, 'vehicle_photo'),
                  eq(media.stage, 'return'),
                  isNull(media.deletedAt),
                  // สัญญาหลายคัน: รูปที่ระบุคันอื่นไม่เอา
                  sql`(${media.assetId} is null or ${media.assetId} = ${id})`,
                ),
              )
              .orderBy(asc(media.createdAt))
          )
        : [];

      // ค่าเสียหายในสัญญาที่มีคันนี้ (ค่าเสียหายผูกกับสัญญา ไม่ใช่รายคัน)
      const damage = await tx.execute<{ description: string; amount: string; at: Date; rental_id: string }>(sql`
        select l.description, l.amount, l.created_at as at, l.rental_id from bill_lines l
        where l.kind = 'damage' and l.rental_id in (select ri.rental_id from rental_items ri where ri.asset_id = ${id})
        order by l.created_at desc limit 3`);

      const remainingKm = x.nextServiceOdometer !== null && x.odometer !== null ? x.nextServiceOdometer - x.odometer : null;
      return {
        asset: {
          id: x.id,
          code: x.code,
          typeId: t.id,
          typeName: t.name,
          publicName: t.publicName,
          tracking: t.tracking,
          model: x.model,
          plate: x.plate,
          color: x.color,
          odometer: x.odometer,
          status: x.status,
          pricePerDay: x.pricePerDay ?? t.pricePerDay,
          ownPrice: x.pricePerDay !== null,
          notes: x.notes,
          coverMediaId: x.coverMediaId ?? t.coverMediaId,
          ownCover: x.coverMediaId !== null,
          qrToken: x.qrToken,
          insuranceExpiresOn: x.insuranceExpiresOn,
          taxExpiresOn: x.taxExpiresOn,
        },
        state: boardState(x.status, cur?.dueAt ?? null),
        currentRental,
        nextBooking: next ?? null,
        service: { intervalKm: t.serviceIntervalKm, nextServiceOdometer: x.nextServiceOdometer, remainingKm },
        lastReturnAt: lastReturn?.returnedAt ?? null,
        lastReturnByName: lastReturn?.by ?? null,
        lastReturnRentalId: lastReturn?.rentalId ?? null,
        lastReturnPhotos,
        damage: damage.rows.map((d) => ({ description: d.description, amount: Number(d.amount), at: new Date(d.at), rentalId: d.rental_id })),
        history,
      };
    });
  }

  /**
   * รายละเอียดประเภท (ใช้กับของนับจำนวน เช่น ตีนกบ) · ต่อไซส์:
   * out = ออกไปแล้ว · booked = คำขอจองที่ยืนยันแล้วกันไว้ (ยอดสูงสุดที่ทับกันใน BOOKED_WINDOW_DAYS วันข้างหน้า)
   * available = quantity − out − booked (ไม่ติดลบ)
   */
  @Get('asset-types/:id/detail')
  async typeDetail(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string) {
    return withTenant(this.db, a, async (tx) => {
      const [t] = await tx.select().from(assetTypes).where(eq(assetTypes.id, id));
      if (!t) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
      const variants = await tx.select().from(assetVariants).where(eq(assetVariants.assetTypeId, id)).orderBy(asc(assetVariants.createdAt));
      const vids = variants.map((v) => v.id);
      const out = vids.length
        ? await tx
            .select({ variantId: rentalItems.variantId, n: sql<number>`sum(${rentalItems.quantity})::int` })
            .from(rentalItems)
            .where(and(inArray(rentalItems.variantId, vids), isNull(rentalItems.releasedAt)))
            .groupBy(rentalItems.variantId)
        : [];
      const outBy = new Map(out.map((o) => [o.variantId, o.n]));
      const booked = await bookedPeak(tx, vids, BOOKED_WINDOW_DAYS);
      const [units] = await tx.select({ n: sql<number>`count(*)::int` }).from(assets).where(and(eq(assets.assetTypeId, id), sql`${assets.status} <> 'retired'`));
      return {
        type: {
          id: t.id,
          name: t.name,
          publicName: t.publicName,
          tracking: t.tracking,
          codePrefix: t.codePrefix,
          pricePerDay: t.pricePerDay,
          deposit: t.deposit,
          serviceIntervalKm: t.serviceIntervalKm,
          coverMediaId: t.coverMediaId,
          archivedAt: t.archivedAt,
          unitCount: units?.n ?? 0,
        },
        bookedWindowDays: BOOKED_WINDOW_DAYS,
        variants: variants.map((v) => {
          const o = outBy.get(v.id) ?? 0;
          const b = booked.get(v.id) ?? 0;
          return { id: v.id, label: v.label, quantity: v.quantity, out: o, booked: b, available: Math.max(0, v.quantity - o - b) };
        }),
      };
    });
  }
}

/** ช่วงที่นับคำขอจองที่กันของไว้ (หน้ารายละเอียดของนับจำนวน) */
const BOOKED_WINDOW_DAYS = 7;

/**
 * ยอดที่คำขอจองยืนยันแล้วกันไว้ต่อไซส์ = ยอดสูงสุดที่ทับกัน ณ จุดใดจุดหนึ่งในช่วง [now, now + days)
 * (วิธีเดียวกับการตรวจ stock_below_out ตอนปรับสต็อก แต่จำกัดช่วงเวลา)
 */
async function bookedPeak(tx: Tx, variantIds: string[], days: number): Promise<Map<string, number>> {
  if (!variantIds.length) return new Map();
  const r = await tx.execute<{ variant_id: string; n: string }>(sql`
    select b1.variant_id, max((select sum(b2.quantity) from booking_items b2
             where b2.variant_id = b1.variant_id and b2.active
               and b2.during @> greatest(lower(b1.during), now()))) as n
    from booking_items b1
    where b1.variant_id in ${sql.raw(`(${variantIds.map((v) => `'${v}'`).join(',')})`)} and b1.active
      and b1.during && tstzrange(now(), now() + make_interval(days => ${days}::int))
    group by b1.variant_id`);
  return new Map(r.rows.map((x) => [x.variant_id, Number(x.n ?? 0)]));
}

/** รหัสถัดไปของประเภท เช่น มี C-01..C-12 → C-13 */
async function nextCode(tx: Parameters<Parameters<typeof withTenant>[2]>[0], typeId: string, prefix: string): Promise<string> {
  const rows = await tx.select({ code: assets.code }).from(assets).where(eq(assets.assetTypeId, typeId));
  const nums = rows.map((r) => Number(r.code.slice(prefix.length))).filter((n) => Number.isInteger(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}${String(next).padStart(2, '0')}`;
}
