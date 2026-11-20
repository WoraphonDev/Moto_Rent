import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { dueAt as computeDue, lateFee, rentalDaysCharge } from '@rental/core';
import { assets, assetTypes, assetVariants, billLines, bills, bookingItems, bookings, customers, rentalItems, rentals, withTenant, type Db, type Tx } from '@rental/db';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../common/audit.js';
import { dbCall } from '../common/db-errors.js';
import { AppError, parse } from '../common/http.js';
import { DB } from '../infra.js';
import { Auth, Roles, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';
import { addLine, baht, clientTime, emit, lockAssets, lockBill, openBillFor, settingsOf, settleIfZero } from './billing.js';

const money = z.number().int().min(0).max(100_000_000);

const checkoutBody = z.object({
  /** id จากเครื่อง (uuid) · ส่งซ้ำได้ ไม่เกิดสัญญาซ้อน */
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  days: z.number().int().min(1).max(365),
  startAt: z.string().datetime({ offset: true }).optional(),
  channel: z.enum(['walk_in', 'hotel', 'booking_page', 'marketplace']).default('walk_in'),
  paymentMode: z.enum(['at_checkout', 'pay_now']).default('at_checkout'),
  deposit: money.nullable().optional(),
  notes: z.string().trim().max(500).optional(),
  /** มาจากคำขอจอง (เฟส 3) · รถที่คำขอนี้กันไว้ปล่อยได้ และคำขอเปลี่ยนเป็น "รับรถแล้ว" */
  bookingId: z.string().uuid().optional(),
  items: z
    .array(
      z.union([
        z.object({ assetId: z.string().uuid() }),
        z.object({ variantId: z.string().uuid(), quantity: z.number().int().min(1).max(100) }),
      ]),
    )
    .min(1)
    .max(20),
});
const extendBody = z.object({ days: z.number().int().min(1).max(60) });
const returnBody = z.object({
  returnedAt: z.string().datetime({ offset: true }).optional(),
  odometer: z.number().int().min(0).optional(),
  /** แก้ค่าคืนช้าที่ระบบเสนอ ต้องใส่เหตุผล */
  lateFeeOverride: z.object({ amount: money, reason: z.string().trim().min(2).max(300) }).optional(),
  fuel: money.optional(),
  damage: z.object({ amount: money, note: z.string().trim().min(2).max(300) }).optional(),
});
const cancelBody = z.object({ reason: z.string().trim().min(2).max(300) });

type Item = z.infer<typeof checkoutBody>['items'][number];

/** สัญญาเช่า: ปล่อยเช่า · ต่อวัน · รับคืน · ยกเลิก (mock 1.03–1.06, 1.09) */
@Controller('v1/rentals')
@UseGuards(SessionGuard)
export class RentalsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post()
  async checkout(@Auth() a: AuthCtx, @Body() body: unknown) {
    const input = parse(checkoutBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        // ส่งซ้ำ (เน็ตหลุดแล้วส่งใหม่) → คืนสัญญาเดิม
        const [existing] = await tx.select({ id: rentals.id }).from(rentals).where(eq(rentals.id, input.id));
        if (existing) return this.detailIn(tx, input.id);

        const settings = await settingsOf(tx, a.orgId);
        if (settings.maxRentalDays !== null && input.days > settings.maxRentalDays) {
          throw new AppError(HttpStatus.BAD_REQUEST, 'too_many_days', { maxDays: settings.maxRentalDays });
        }
        const [customer] = await tx.select().from(customers).where(eq(customers.id, input.customerId));
        if (!customer) throw new AppError(HttpStatus.NOT_FOUND, 'customer_not_found');
        if (customer.doNotRent) throw new AppError(HttpStatus.CONFLICT, 'customer_blocked', { reason: customer.doNotRentReason });

        // เวลาที่กดจริงจากเครื่อง (โหมดออฟไลน์ส่งทีหลังแล้วเวลาไม่เลื่อน) · ย้อน/ล่วงหน้าเกินกำหนดถูกปฏิเสธ
        const { at: startAt, risky: timeSkew } = clientTime(input.startAt, a);
        const due = computeDue(startAt, input.days);

        // ลำดับล็อกเดียวกับการยืนยันคำขอจอง กัน deadlock: แถวคำขอจอง → ของรายชิ้น → ไซส์
        let booking: typeof bookings.$inferSelect | undefined;
        if (input.bookingId) {
          [booking] = await tx.select().from(bookings).where(eq(bookings.id, input.bookingId)).for('update');
          if (!booking) throw new AppError(HttpStatus.NOT_FOUND, 'booking_not_found');
          if (booking.status !== 'confirmed' && booking.status !== 'requested') throw new AppError(HttpStatus.CONFLICT, 'booking_closed', { status: booking.status });
          if (booking.customerId && booking.customerId !== customer.id) throw new AppError(HttpStatus.CONFLICT, 'booking_customer_mismatch');
        }
        await lockAssets(
          tx,
          input.items.map((it) => ('assetId' in it ? it.assetId : null)),
          input.items.map((it) => ('variantId' in it ? it.variantId : null)),
        );
        const lines = await this.priceItems(tx, input.items, input.days, { start: startAt, end: due, bookingId: input.bookingId ?? null });
        // รถที่คำขอจองอื่นกันไว้ในช่วงที่ทับกัน ปล่อยไม่ได้ (คำขอของตัวเองปล่อยได้)
        const unitIds = lines.map((l) => l.assetId).filter((x): x is string => !!x);
        if (unitIds.length) {
          const held = await tx.execute<{ asset_id: string; code: string; booking_code: string }>(sql`
            select bi.asset_id, a.code, b.code as booking_code from booking_items bi
            join bookings b on b.id = bi.booking_id join assets a on a.id = bi.asset_id
            where bi.active and bi.asset_id in ${sql.raw(`(${unitIds.map((u) => `'${u}'`).join(',')})`)}
              and bi.during && tstzrange(${startAt.toISOString()}::timestamptz, ${due.toISOString()}::timestamptz)
              ${input.bookingId ? sql`and bi.booking_id <> ${input.bookingId}` : sql``}
            limit 1`);
          const h = held.rows[0];
          if (h) throw new AppError(HttpStatus.CONFLICT, 'asset_reserved', { code: h.code, bookingCode: h.booking_code });
        }

        await tx.insert(rentals).values({
          id: input.id,
          orgId: a.orgId,
          customerId: customer.id,
          channel: input.channel,
          paymentMode: input.paymentMode,
          deposit: input.deposit ?? null,
          notes: input.notes,
          startAt,
          dueAt: due,
          createdBy: a.userId,
          bookingId: booking?.id ?? null,
        });
        await tx.insert(rentalItems).values(
          lines.map((l) => ({
            orgId: a.orgId,
            rentalId: input.id,
            assetTypeId: l.assetTypeId,
            assetId: l.assetId,
            variantId: l.variantId,
            quantity: l.quantity,
            pricePerDay: l.pricePerDay,
          })),
        );
        const billId = await openBillFor(tx, a, customer.id);
        for (const l of lines) {
          await addLine(tx, a, { billId, rentalId: input.id, kind: l.isGear ? 'gear' : 'rental', description: `${l.label} · ${input.days} วัน`, amount: l.amount });
        }
        await audit(tx, a, {
          action: 'rental.created',
          entityType: 'rental',
          entityId: input.id,
          after: { customer: customer.fullName, days: input.days, startAt, items: lines.map((l) => l.label), total: lines.reduce((s, l) => s + l.amount, 0) },
          // เวลาเริ่มเช่าต่างจากเวลาเซิร์ฟเวอร์มาก = ลงย้อนหลัง/ล่วงหน้า · เจ้าของควรเห็น
          risk: timeSkew ? 'risky' : 'normal',
        });
        if (booking) {
          await tx.update(bookingItems).set({ active: false }).where(eq(bookingItems.bookingId, booking.id));
          await tx
            .update(bookings)
            .set({ status: 'picked_up', rentalId: input.id, customerId: customer.id })
            .where(eq(bookings.id, booking.id));
          await audit(tx, a, { action: 'booking.picked_up', entityType: 'booking', entityId: booking.id, after: { rentalId: input.id } });
        }
        await emit(tx, a, 'rental.created', { rentalId: input.id, assetIds: lines.map((l) => l.assetId).filter(Boolean), dueAt: due.toISOString() });
        return this.detailIn(tx, input.id);
      }),
    );
  }

  @Get()
  async list(@Auth() a: AuthCtx, @Query('status') status?: string) {
    const st = status === 'returned' || status === 'cancelled' ? status : 'active';
    return withTenant(this.db, a, async (tx) => {
      const rows = await tx
        .select({
          id: rentals.id,
          status: rentals.status,
          startAt: rentals.startAt,
          dueAt: rentals.dueAt,
          returnedAt: rentals.returnedAt,
          customerId: customers.id,
          customerName: customers.fullName,
          hotelRoom: customers.hotelRoom,
          phone: customers.phone,
        })
        .from(rentals)
        .innerJoin(customers, eq(customers.id, rentals.customerId))
        .where(eq(rentals.status, st))
        .orderBy(st === 'active' ? asc(rentals.dueAt) : desc(rentals.returnedAt))
        .limit(200);
      const items = await this.itemsFor(tx, rows.map((r) => r.id));
      const now = Date.now();
      return rows.map((r) => ({ ...r, overdue: r.status === 'active' && r.dueAt.getTime() < now, items: items.get(r.id) ?? [] }));
    });
  }

  @Get(':id')
  async detail(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string) {
    return withTenant(this.db, a, (tx) => this.detailIn(tx, id));
  }

  /** ค่าที่ระบบเสนอก่อนกดรับคืน (หน้า 1.06 แสดงให้พนักงานเห็นก่อนยืนยัน) */
  @Get(':id/return-preview')
  async returnPreview(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Query('at') at?: string) {
    return withTenant(this.db, a, async (tx) => {
      const r = await this.activeRental(tx, id);
      const returnedAt = at ? new Date(at) : new Date();
      return { lateMinutes: Math.max(0, Math.floor((returnedAt.getTime() - r.dueAt.getTime()) / 60_000)), suggestedLateFee: await this.suggestLateFee(tx, a, r, returnedAt) };
    });
  }

  @Post(':id/extend')
  @HttpCode(200)
  async extend(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { days } = parse(extendBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const r = await this.activeRental(tx, id, true);
        const settings = await settingsOf(tx, a.orgId);
        const newDue = computeDue(r.dueAt, days);
        const totalDays = Math.round((newDue.getTime() - r.startAt.getTime()) / 86_400_000);
        if (settings.maxRentalDays !== null && totalDays > settings.maxRentalDays) {
          throw new AppError(HttpStatus.BAD_REQUEST, 'too_many_days', { maxDays: settings.maxRentalDays });
        }
        const items = (await this.itemsFor(tx, [id])).get(id) ?? [];
        // รถที่คำขอจองยืนยันไว้หลังวันคืนเดิม ต่อทับไม่ได้
        const unitIds = items.filter((it) => it.assetId && !it.releasedAt).map((it) => it.assetId!);
        await lockAssets(tx, unitIds);
        if (unitIds.length) {
          const held = await tx.execute<{ code: string; booking_code: string }>(sql`
            select a.code, b.code as booking_code from booking_items bi
            join bookings b on b.id = bi.booking_id join assets a on a.id = bi.asset_id
            where bi.active and bi.asset_id = any(${sql.raw(`array[${unitIds.map((u) => `'${u}'::uuid`).join(',')}]`)})
              and bi.during && tstzrange(${r.dueAt.toISOString()}::timestamptz, ${newDue.toISOString()}::timestamptz)
            limit 1`);
          const h = held.rows[0];
          if (h) throw new AppError(HttpStatus.CONFLICT, 'asset_reserved', { code: h.code, bookingCode: h.booking_code });
        }
        await tx.update(rentals).set({ dueAt: newDue }).where(eq(rentals.id, id));
        const billId = await openBillFor(tx, a, r.customerId);
        for (const it of items) {
          await addLine(tx, a, {
            billId,
            rentalId: id,
            kind: 'extension',
            description: `ต่อ ${it.label} · ${days} วัน`,
            amount: rentalDaysCharge({ perDay: it.pricePerDay, maxDays: null }, days, it.quantity),
          });
        }
        await audit(tx, a, { action: 'rental.extended', entityType: 'rental', entityId: id, before: { dueAt: r.dueAt }, after: { dueAt: newDue, days } });
        await emit(tx, a, 'rental.extended', { rentalId: id, dueAt: newDue.toISOString() });
        return this.detailIn(tx, id);
      }),
    );
  }

  @Post(':id/return')
  @HttpCode(200)
  async return(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(returnBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const r = await this.activeRental(tx, id, true);
        // เวลาที่กดรับคืนจริง (ส่งจากเครื่อง) · ออฟไลน์ส่งทีหลังแล้วไม่โดนค่าคืนช้าเพิ่ม
        const { at: returnedAt, risky: timeSkew } = clientTime(input.returnedAt, a);
        if (returnedAt < r.startAt) throw new AppError(HttpStatus.BAD_REQUEST, 'returned_before_start');
        const suggested = await this.suggestLateFee(tx, a, r, returnedAt);
        const charged = input.lateFeeOverride ? input.lateFeeOverride.amount : suggested;

        await tx.update(rentals).set({ status: 'returned', returnedAt, returnedBy: a.userId }).where(eq(rentals.id, id));
        const items = await tx.update(rentalItems).set({ releasedAt: returnedAt }).where(and(eq(rentalItems.rentalId, id), isNull(rentalItems.releasedAt))).returning();
        const unitIds = items.map((i) => i.assetId).filter((x): x is string => !!x);
        if (input.odometer !== undefined && unitIds.length === 1) {
          await tx.update(assets).set({ odometer: input.odometer }).where(eq(assets.id, unitIds[0]!));
        }

        const billId = await openBillFor(tx, a, r.customerId);
        if (charged > 0) {
          const late = Math.max(0, Math.floor((returnedAt.getTime() - r.dueAt.getTime()) / 60_000));
          await addLine(tx, a, {
            billId,
            rentalId: id,
            kind: 'late_fee',
            description: `คืนช้า ${Math.floor(late / 60)}:${String(late % 60).padStart(2, '0')} ชม.`,
            amount: charged,
            reason: input.lateFeeOverride?.reason ?? null,
          });
        }
        if (input.fuel) await addLine(tx, a, { billId, rentalId: id, kind: 'fuel', description: 'ค่าน้ำมัน', amount: input.fuel });
        if (input.damage && input.damage.amount > 0) {
          await addLine(tx, a, { billId, rentalId: id, kind: 'damage', description: `ค่าเสียหาย: ${input.damage.note}`, amount: input.damage.amount, reason: input.damage.note });
        }
        await audit(tx, a, {
          action: 'rental.returned',
          entityType: 'rental',
          entityId: id,
          after: { returnedAt, lateFee: charged, suggestedLateFee: suggested, fuel: input.fuel ?? 0, damage: input.damage?.amount ?? 0 },
          reason: input.lateFeeOverride?.reason ?? null,
          // ลดค่าคืนช้าต่ำกว่าที่ระบบคิด = รายการเสี่ยง (เจ้าของเห็นในประวัติ)
          // หรือเวลาคืนต่างจากเวลาเซิร์ฟเวอร์มาก (ลงย้อนหลังเลี่ยงค่าคืนช้าได้)
          risk: (input.lateFeeOverride && input.lateFeeOverride.amount < suggested) || timeSkew ? 'risky' : 'normal',
        });
        await emit(tx, a, 'rental.returned', { rentalId: id, assetIds: unitIds });
        return this.detailIn(tx, id);
      }),
    );
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles('owner')
  async cancel(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parse(cancelBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const r = await this.activeRental(tx, id, true);
        await tx.update(rentals).set({ status: 'cancelled' }).where(eq(rentals.id, id));
        await tx.update(rentalItems).set({ releasedAt: new Date() }).where(and(eq(rentalItems.rentalId, id), isNull(rentalItems.releasedAt)));
        // คืนยอดของสัญญานี้ในบิลที่ยังเปิด (บิลที่จ่ายแล้วต้องคืนเงินแยก · เฟสถัดไป)
        const [sum] = await tx
          .select({ total: sql<number>`coalesce(sum(${billLines.amount}), 0)`.mapWith(Number), billId: billLines.billId })
          .from(billLines)
          .innerJoin(bills, and(eq(bills.id, billLines.billId), eq(bills.status, 'open')))
          .where(eq(billLines.rentalId, id))
          .groupBy(billLines.billId);
        if (sum && sum.total > 0) {
          const bill = await lockBill(tx, sum.billId);
          await addLine(tx, a, { billId: sum.billId, rentalId: id, kind: 'discount', description: 'ยกเลิกสัญญา', amount: -sum.total, reason });
          // ยอดเหลือ 0 = ปิดบิล · ติดลบ (จ่ายไปแล้ว) = บิลเปิดค้างไว้ แสดง "ต้องคืนเงิน"
          if (bill) await settleIfZero(tx, a, sum.billId, bill.customerId);
        }
        await audit(tx, a, { action: 'rental.cancelled', entityType: 'rental', entityId: id, reason, risk: 'risky', before: { status: r.status } });
        await emit(tx, a, 'rental.cancelled', { rentalId: id });
        return this.detailIn(tx, id);
      }),
    );
  }

  // ---------- helpers ----------

  /** ต้องล็อกของด้วย lockAssets ก่อนเรียก */
  private async priceItems(tx: Tx, items: Item[], days: number, window: { start: Date; end: Date; bookingId: string | null }) {
    const out: Array<{ assetTypeId: string; assetId: string | null; variantId: string | null; quantity: number; pricePerDay: number; amount: number; label: string; isGear: boolean }> = [];
    for (const it of items) {
      if ('assetId' in it) {
        const [row] = await tx
          .select({ id: assets.id, code: assets.code, status: assets.status, typeId: assetTypes.id, typeName: assetTypes.name, price: sql<number>`coalesce(${assets.pricePerDay}, ${assetTypes.pricePerDay})`.mapWith(Number) })
          .from(assets)
          .innerJoin(assetTypes, eq(assetTypes.id, assets.assetTypeId))
          .where(eq(assets.id, it.assetId));
        if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'asset_not_found');
        if (row.status !== 'available') throw new AppError(HttpStatus.CONFLICT, 'asset_unavailable', { code: row.code, status: row.status });
        out.push({ assetTypeId: row.typeId, assetId: row.id, variantId: null, quantity: 1, pricePerDay: row.price, amount: rentalDaysCharge({ perDay: row.price, maxDays: null }, days), label: `${row.typeName} ${row.code}`, isGear: false });
      } else {
        // ไซส์นี้ถูกล็อกแล้ว (lockAssets) · คำขอพร้อมกันจากหลายเครื่องรอคิว จึงไม่ปล่อยเกินจำนวนที่มี
        const [v] = await tx
          .select({ id: assetVariants.id, label: assetVariants.label, quantity: assetVariants.quantity, typeId: assetTypes.id, typeName: assetTypes.name, price: assetTypes.pricePerDay })
          .from(assetVariants)
          .innerJoin(assetTypes, eq(assetTypes.id, assetVariants.assetTypeId))
          .where(eq(assetVariants.id, it.variantId));
        if (!v) throw new AppError(HttpStatus.NOT_FOUND, 'variant_not_found');
        const [used] = await tx
          .select({ n: sql<number>`coalesce(sum(${rentalItems.quantity}), 0)::int` })
          .from(rentalItems)
          .where(and(eq(rentalItems.variantId, v.id), isNull(rentalItems.releasedAt)));
        // คำขอจองที่ยืนยันแล้วกันไซส์นี้ไว้ในช่วงที่ทับกัน (ยกเว้นคำขอที่กำลังรับรถ)
        const [booked] = (
          await tx.execute<{ n: string }>(sql`
            select coalesce(sum(bi.quantity), 0) as n from booking_items bi
            where bi.variant_id = ${v.id} and bi.active
              and bi.during && tstzrange(${window.start.toISOString()}::timestamptz, ${window.end.toISOString()}::timestamptz)
              ${window.bookingId ? sql`and bi.booking_id <> ${window.bookingId}` : sql``}`)
        ).rows;
        const available = v.quantity - (used?.n ?? 0) - Number(booked?.n ?? 0);
        if (it.quantity > available) throw new AppError(HttpStatus.CONFLICT, 'not_enough_stock', { label: `${v.typeName} ${v.label}`, available });
        out.push({ assetTypeId: v.typeId, assetId: null, variantId: v.id, quantity: it.quantity, pricePerDay: v.price, amount: rentalDaysCharge({ perDay: v.price, maxDays: null }, days, it.quantity), label: `${v.typeName} ${v.label} × ${it.quantity}`, isGear: true });
      }
    }
    return out;
  }

  private async activeRental(tx: Tx, id: string, lock = false) {
    const q = tx.select().from(rentals).where(eq(rentals.id, id));
    const [r] = lock ? await q.for('update') : await q;
    if (!r) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
    if (r.status !== 'active') throw new AppError(HttpStatus.CONFLICT, 'rental_closed');
    return r;
  }

  private async suggestLateFee(tx: Tx, a: AuthCtx, r: typeof rentals.$inferSelect, returnedAt: Date) {
    const settings = await settingsOf(tx, a.orgId);
    const items = (await this.itemsFor(tx, [r.id])).get(r.id) ?? [];
    const policy = { graceMinutes: settings.lateGraceMinutes, halfDayUntilMinutes: settings.lateHalfDayUntilMinutes };
    return items.reduce((sum, it) => sum + lateFee({ perDay: it.pricePerDay, maxDays: null }, r.dueAt, returnedAt, policy) * it.quantity, 0);
  }

  private async itemsFor(tx: Tx, rentalIds: string[]) {
    const map = new Map<string, Array<{ id: string; assetId: string | null; code: string | null; variantId: string | null; label: string; quantity: number; pricePerDay: number; releasedAt: Date | null }>>();
    if (!rentalIds.length) return map;
    const rows = await tx
      .select({
        id: rentalItems.id,
        rentalId: rentalItems.rentalId,
        assetId: rentalItems.assetId,
        code: assets.code,
        variantId: rentalItems.variantId,
        variantLabel: assetVariants.label,
        typeName: assetTypes.name,
        quantity: rentalItems.quantity,
        pricePerDay: rentalItems.pricePerDay,
        releasedAt: rentalItems.releasedAt,
      })
      .from(rentalItems)
      .innerJoin(assetTypes, eq(assetTypes.id, rentalItems.assetTypeId))
      .leftJoin(assets, eq(assets.id, rentalItems.assetId))
      .leftJoin(assetVariants, eq(assetVariants.id, rentalItems.variantId))
      .where(inArray(rentalItems.rentalId, rentalIds));
    for (const r of rows) {
      const list = map.get(r.rentalId) ?? [];
      list.push({
        id: r.id,
        assetId: r.assetId,
        code: r.code,
        variantId: r.variantId,
        label: r.code ? `${r.typeName} ${r.code}` : `${r.typeName} ${r.variantLabel} × ${r.quantity}`,
        quantity: r.quantity,
        pricePerDay: r.pricePerDay,
        releasedAt: r.releasedAt,
      });
      map.set(r.rentalId, list);
    }
    return map;
  }

  private async detailIn(tx: Tx, id: string) {
    const [r] = await tx
      .select({
        rental: rentals,
        customer: { id: customers.id, fullName: customers.fullName, hotelRoom: customers.hotelRoom, phone: customers.phone, checkoutDate: customers.checkoutDate },
      })
      .from(rentals)
      .innerJoin(customers, eq(customers.id, rentals.customerId))
      .where(eq(rentals.id, id));
    if (!r) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
    const items = (await this.itemsFor(tx, [id])).get(id) ?? [];
    const lines = await tx
      .select({ id: billLines.id, billId: billLines.billId, kind: billLines.kind, description: billLines.description, amount: billLines.amount, reason: billLines.reason, createdAt: billLines.createdAt })
      .from(billLines)
      .where(eq(billLines.rentalId, id))
      .orderBy(asc(billLines.createdAt));
    // บิลที่สัญญานี้อยู่ · ยังไม่มีรายการ (ราคา 0) ใช้บิลเปิดของลูกค้า
    let billId = lines[0]?.billId ?? null;
    if (!billId) {
      const [open] = await tx.select({ id: bills.id }).from(bills).where(and(eq(bills.customerId, r.customer.id), eq(bills.status, 'open')));
      billId = open?.id ?? null;
    }
    return {
      ...r.rental,
      billId,
      overdue: r.rental.status === 'active' && r.rental.dueAt.getTime() < Date.now(),
      customer: r.customer,
      items,
      lines,
      total: lines.reduce((s, l) => s + l.amount, 0),
      totalText: baht(lines.reduce((s, l) => s + l.amount, 0)),
    };
  }
}
