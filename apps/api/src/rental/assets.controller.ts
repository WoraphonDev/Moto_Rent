import { Body, Controller, Get, HttpStatus, Inject, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { assets, assetTypes, assetVariants, customers, rentalItems, rentals, withTenant, type Db } from '@rental/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../common/audit.js';
import { dbCall } from '../common/db-errors.js';
import { AppError, parse } from '../common/http.js';
import { DB } from '../infra.js';
import { Auth, Roles, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';
import { lockAssets } from './billing.js';

const money = z.number().int().min(0).max(100_000_000);

const typeBody = z.object({
  name: z.string().trim().min(1).max(60),
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
  pricePerDay: money.optional(),
  deposit: money.nullable().optional(),
  listedOnMarketplace: z.boolean().optional(),
  archived: z.boolean().optional(),
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
});

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
          .values({ orgId: a.orgId, name: input.name, tracking: input.tracking, codePrefix: input.codePrefix ?? null, pricePerDay: input.pricePerDay, deposit: input.deposit ?? null })
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
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [before] = await tx.select().from(assetTypes).where(eq(assetTypes.id, id));
        if (!before) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        const { archived, ...rest } = input;
        const [row] = await tx
          .update(assetTypes)
          .set({ ...rest, ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }) })
          .where(eq(assetTypes.id, id))
          .returning();
        await audit(tx, a, {
          action: input.pricePerDay !== undefined && input.pricePerDay !== before.pricePerDay ? 'asset_type.price_changed' : 'asset_type.updated',
          entityType: 'asset_type',
          entityId: id,
          before: { name: before.name, pricePerDay: before.pricePerDay, deposit: before.deposit, listedOnMarketplace: before.listedOnMarketplace },
          after: input,
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
      return rows.map((r) => ({
        ...r,
        state: r.rentalId ? (r.dueAt && r.dueAt.getTime() < now ? 'overdue' : 'rented') : r.status === 'maintenance' ? 'maintenance' : 'available',
      }));
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
        const [row] = await tx.update(assets).set(input).where(eq(assets.id, id)).returning();
        await audit(tx, a, {
          action: 'asset.updated',
          entityType: 'asset',
          entityId: id,
          before: { status: before.status, odometer: before.odometer, pricePerDay: before.pricePerDay },
          after: input,
        });
        return row;
      }),
    );
  }
}

/** รหัสถัดไปของประเภท เช่น มี C-01..C-12 → C-13 */
async function nextCode(tx: Parameters<Parameters<typeof withTenant>[2]>[0], typeId: string, prefix: string): Promise<string> {
  const rows = await tx.select({ code: assets.code }).from(assets).where(eq(assets.assetTypeId, typeId));
  const nums = rows.map((r) => Number(r.code.slice(prefix.length))).filter((n) => Number.isInteger(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}${String(next).padStart(2, '0')}`;
}
