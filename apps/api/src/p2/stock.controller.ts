import { Body, Controller, Get, HttpStatus, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { assetTypes, assetVariants, rentalItems, stockAdjustments, users, withTenant, type Db } from '@rental/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../common/audit.js';
import { dbCall } from '../common/db-errors.js';
import { AppError, parse } from '../common/http.js';
import { DB } from '../infra.js';
import { Auth, Roles, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';

const adjustBody = z.object({
  delta: z
    .number()
    .int()
    .min(-10_000)
    .max(10_000)
    .refine((v) => v !== 0, 'delta_zero'),
  reason: z.string().trim().min(2).max(300),
});

/** ปรับสต็อกของนับจำนวน: ซื้อเพิ่ม / ชำรุด / หาย / นับใหม่ (mock 2.01 / 2.W3) */
@Controller('v1/asset-variants')
@UseGuards(SessionGuard)
export class StockController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post(':id/adjust')
  @Roles('owner', 'manager')
  async adjust(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(adjustBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        // ล็อกไซส์นี้แบบเดียวกับตอนปล่อยเช่า กันนับของที่ออกไปพลาดระหว่างปรับ
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`variant:${id}`}, 0))`);
        const [v] = await tx
          .select({ id: assetVariants.id, label: assetVariants.label, quantity: assetVariants.quantity, typeName: assetTypes.name })
          .from(assetVariants)
          .innerJoin(assetTypes, eq(assetTypes.id, assetVariants.assetTypeId))
          .where(eq(assetVariants.id, id));
        if (!v) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        const [used] = await tx
          .select({ n: sql<number>`coalesce(sum(${rentalItems.quantity}), 0)::int` })
          .from(rentalItems)
          .where(and(eq(rentalItems.variantId, id), isNull(rentalItems.releasedAt)));
        const out = used?.n ?? 0;
        // คำขอจองที่ยืนยันแล้วกันไซส์นี้ไว้ล่วงหน้า · ใช้ยอดสูงสุดที่ทับกันในช่วงใดช่วงหนึ่ง
        const [peak] = (
          await tx.execute<{ n: string }>(sql`
            select coalesce(max((select sum(b2.quantity) from booking_items b2
                     where b2.variant_id = b1.variant_id and b2.active
                       and b2.during @> greatest(lower(b1.during), now()))), 0) as n
            from booking_items b1
            where b1.variant_id = ${id} and b1.active and upper(b1.during) > now()`)
        ).rows;
        const booked = Number(peak?.n ?? 0);
        const next = v.quantity + input.delta;
        if (next < out + booked) throw new AppError(HttpStatus.CONFLICT, 'stock_below_out', { out, booked, quantity: v.quantity });
        await tx.insert(stockAdjustments).values({ orgId: a.orgId, variantId: id, delta: input.delta, reason: input.reason, createdBy: a.userId });
        const [row] = await tx.update(assetVariants).set({ quantity: next }).where(eq(assetVariants.id, id)).returning();
        await audit(tx, a, {
          action: 'stock.adjusted',
          entityType: 'asset_variant',
          entityId: id,
          before: { quantity: v.quantity },
          after: { quantity: next, delta: input.delta, label: `${v.typeName} ${v.label}` },
          reason: input.reason,
          // ตัดสต็อกจำนวนมาก (ของหาย) ให้เจ้าของเห็นเป็นรายการเสี่ยง
          risk: input.delta <= -3 ? 'risky' : 'normal',
        });
        return { ...row!, out, available: next - out };
      }),
    );
  }

  @Get(':id/adjustments')
  async history(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string) {
    return withTenant(this.db, a, (tx) =>
      tx
        .select({ id: stockAdjustments.id, delta: stockAdjustments.delta, reason: stockAdjustments.reason, createdAt: stockAdjustments.createdAt, by: users.displayName })
        .from(stockAdjustments)
        .innerJoin(users, eq(users.id, stockAdjustments.createdBy))
        .where(eq(stockAdjustments.variantId, id))
        .orderBy(desc(stockAdjustments.createdAt))
        .limit(100),
    );
  }
}
