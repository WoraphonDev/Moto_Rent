import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { assets, assetTypes, assetVariants, bookingItems, bookings, customers, orgs, withTenant, type Db, type Tx } from '@rental/db';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../common/audit.js';
import { dbCall } from '../common/db-errors.js';
import { AppError, parse, pgError } from '../common/http.js';
import { DB } from '../infra.js';
import { Auth, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';
import { emit, lockAssets } from '../rental/billing.js';

const confirmBody = z.object({
  assignments: z.array(z.object({ itemId: z.string().uuid(), assetId: z.string().uuid() })).max(20).default([]),
});
const rejectBody = z.object({ reason: z.string().trim().min(2).max(300) });

type BookingRow = typeof bookings.$inferSelect;

/** ช่วงที่คำขอกันของไว้ [pickup, pickup + days) */
function span(b: Pick<BookingRow, 'pickupAt' | 'days'>) {
  return { start: b.pickupAt, end: new Date(b.pickupAt.getTime() + b.days * 86_400_000) };
}

/** คำขอจอง (mock 3.05 / 3.W2): ยืนยัน + กำหนดคัน · ปฏิเสธ · ไม่มารับ · ปฏิทินรถ */
@Controller('v1/bookings')
@UseGuards(SessionGuard)
export class BookingsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Auth() a: AuthCtx, @Query('status') status?: string) {
    return withTenant(this.db, a, async (tx) => {
      const where =
        status === 'requested' || status === 'confirmed' || status === 'rejected' || status === 'cancelled' || status === 'picked_up' || status === 'no_show'
          ? eq(bookings.status, status)
          : undefined;
      const rows = await tx
        .select()
        .from(bookings)
        .where(where)
        .orderBy(status === 'requested' || status === 'confirmed' ? asc(bookings.pickupAt) : desc(bookings.createdAt))
        .limit(200);
      return Promise.all(rows.map((b) => this.decorate(tx, b)));
    });
  }

  /** ปฏิทินรถ: แถว = ของรายชิ้น · ช่วงสี = สัญญา / คำขอที่ยืนยัน / ซ่อม · คำขอที่ยังไม่กำหนดคันแยกไว้ด้านข้าง */
  @Get('calendar')
  async calendar(@Auth() a: AuthCtx, @Query('from') fromRaw?: string, @Query('days') daysRaw?: string) {
    const days = Math.min(31, Math.max(1, Number(daysRaw ?? 14) || 14));
    return withTenant(this.db, a, async (tx) => {
      const [org] = await tx.select({ tz: orgs.timezone }).from(orgs).where(eq(orgs.id, a.orgId));
      const tz = org?.tz ?? 'Asia/Bangkok';
      const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw ?? '') ? fromRaw! : null;
      const [range] = (
        await tx.execute<{ start: string; end: string; date: string }>(sql`
          select (d::timestamp at time zone ${tz}::text) as start, ((d + ${days}::int)::timestamp at time zone ${tz}::text) as end, d::text as date
          from (select coalesce(${fromDate}::date, (now() at time zone ${tz}::text)::date) as d) x`)
      ).rows;
      const start = new Date(range!.start);
      const end = new Date(range!.end);

      const units = await tx
        .select({ id: assets.id, code: assets.code, status: assets.status, typeName: assetTypes.name })
        .from(assets)
        .innerJoin(assetTypes, eq(assetTypes.id, assets.assetTypeId))
        .where(sql`${assets.status} <> 'retired'`)
        .orderBy(asc(assetTypes.sortOrder), asc(assetTypes.createdAt), asc(assets.code));

      const rentalSegs = await tx.execute<{ asset_id: string; rental_id: string; start_at: string; end_at: string; status: string; name: string; due_at: string }>(sql`
        select ri.asset_id, r.id as rental_id, r.start_at, coalesce(r.returned_at, greatest(r.due_at, now())) as end_at, r.status, c.full_name as name, r.due_at
        from rental_items ri join rentals r on r.id = ri.rental_id join customers c on c.id = r.customer_id
        where ri.asset_id is not null and r.status <> 'cancelled'
          and tstzrange(r.start_at, coalesce(r.returned_at, greatest(r.due_at, now()))) && tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)`);
      const bookingSegs = await tx.execute<{ asset_id: string; booking_id: string; start_at: string; end_at: string; code: string; name: string }>(sql`
        select bi.asset_id, b.id as booking_id, lower(bi.during) as start_at, upper(bi.during) as end_at, b.code, b.full_name as name
        from booking_items bi join bookings b on b.id = bi.booking_id
        where bi.active and bi.asset_id is not null and bi.during && tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)`);
      const requests = await tx
        .select()
        .from(bookings)
        .where(and(eq(bookings.status, 'requested'), sql`${bookings.pickupAt} < ${end.toISOString()}::timestamptz`))
        .orderBy(asc(bookings.pickupAt));

      const now = Date.now();
      const rows = units.map((u) => {
        const segments: Array<{ kind: string; start: string; end: string; label: string; refId: string | null; overdue?: boolean }> = [];
        if (u.status === 'maintenance') segments.push({ kind: 'maintenance', start: start.toISOString(), end: end.toISOString(), label: 'ซ่อม', refId: null });
        for (const r of rentalSegs.rows.filter((x) => x.asset_id === u.id)) {
          segments.push({
            kind: r.status === 'active' ? 'rental' : 'rental_returned',
            start: new Date(r.start_at).toISOString(),
            end: new Date(r.end_at).toISOString(),
            label: r.name,
            refId: r.rental_id,
            overdue: r.status === 'active' && new Date(r.due_at).getTime() < now,
          });
        }
        for (const b of bookingSegs.rows.filter((x) => x.asset_id === u.id)) {
          segments.push({ kind: 'booking', start: new Date(b.start_at).toISOString(), end: new Date(b.end_at).toISOString(), label: `${b.code} · ${b.name}`, refId: b.booking_id });
        }
        segments.sort((x, y) => x.start.localeCompare(y.start));
        return { ...u, segments };
      });
      return {
        from: range!.date,
        start: start.toISOString(),
        end: end.toISOString(),
        days,
        timezone: tz,
        assets: rows,
        requests: await Promise.all(requests.map((b) => this.decorate(tx, b))),
      };
    });
  }

  @Get(':id')
  async detail(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string) {
    return withTenant(this.db, a, async (tx) => this.decorate(tx, await this.load(tx, id)));
  }

  @Post(':id/confirm')
  @HttpCode(200)
  async confirm(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { assignments } = parse(confirmBody, body);
    return this.mapReserved(() =>
      dbCall(() =>
        withTenant(this.db, a, async (tx) => {
          const b = await this.load(tx, id, true);
          if (b.status !== 'requested') throw new AppError(HttpStatus.CONFLICT, 'booking_closed', { status: b.status });
          const { start, end } = span(b);
          const items = await this.items(tx, [b.id]);
          // ลำดับล็อกเดียวกับการปล่อยเช่า กัน deadlock: แถวคำขอจอง (ล็อกแล้ว) → ของรายชิ้น → ไซส์
          await lockAssets(
            tx,
            items.filter((it) => it.tracking === 'unit').map((it) => assignments.find((x) => x.itemId === it.id)?.assetId),
            items.filter((it) => it.tracking !== 'unit').map((it) => it.variantId),
          );
          const assigned: string[] = [];
          for (const it of items) {
            if (it.tracking === 'unit') {
              const as = assignments.find((x) => x.itemId === it.id);
              if (!as) throw new AppError(HttpStatus.BAD_REQUEST, 'assignment_required', { itemId: it.id });
              const [asset] = await tx.select().from(assets).where(eq(assets.id, as.assetId));
              if (!asset || asset.assetTypeId !== it.assetTypeId) throw new AppError(HttpStatus.BAD_REQUEST, 'asset_wrong_type');
              if (asset.status !== 'available') throw new AppError(HttpStatus.CONFLICT, 'asset_unavailable', { code: asset.code });
              if (await this.rentalOverlaps(tx, asset.id, start, end)) throw new AppError(HttpStatus.CONFLICT, 'asset_reserved', { code: asset.code });
              await tx.execute(sql`update booking_items set asset_id = ${asset.id}, active = true,
                during = tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz) where id = ${it.id}`);
              assigned.push(asset.code);
            } else {
              // ของนับจำนวน: ต้องเหลือพอตลอดช่วง (นับแบบระวังไว้ก่อน) · ไซส์ถูกล็อกแล้วด้านบน
              const [left] = (
                await tx.execute<{ n: number }>(sql`
                  select v.quantity
                    - (select coalesce(sum(ri.quantity), 0) from rental_items ri join rentals r on r.id = ri.rental_id
                       where ri.variant_id = v.id and ri.released_at is null
                         and tstzrange(r.start_at, greatest(r.due_at, now())) && tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz))
                    - (select coalesce(sum(bi.quantity), 0) from booking_items bi
                       where bi.variant_id = v.id and bi.active and bi.during && tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)) as n
                  from asset_variants v where v.id = ${it.variantId}`)
              ).rows;
              if (!left || Number(left.n) < it.quantity) throw new AppError(HttpStatus.CONFLICT, 'not_enough_stock', { label: it.label, available: Math.max(0, Number(left?.n ?? 0)) });
              await tx.execute(sql`update booking_items set active = true,
                during = tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz) where id = ${it.id}`);
            }
          }
          const customerId = await this.customerFor(tx, a, b);
          await tx
            .update(bookings)
            .set({ status: 'confirmed', customerId, decidedBy: a.userId, decidedAt: new Date() })
            .where(eq(bookings.id, b.id));
          await audit(tx, a, { action: 'booking.confirmed', entityType: 'booking', entityId: b.id, after: { code: b.code, assets: assigned } });
          await emit(tx, a, 'booking.confirmed', { bookingId: b.id, code: b.code });
          return this.decorate(tx, await this.load(tx, b.id));
        }),
      ),
    );
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parse(rejectBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const b = await this.load(tx, id, true);
        if (b.status !== 'requested' && b.status !== 'confirmed') throw new AppError(HttpStatus.CONFLICT, 'booking_closed', { status: b.status });
        await tx.update(bookingItems).set({ active: false }).where(eq(bookingItems.bookingId, b.id));
        await tx.update(bookings).set({ status: 'rejected', rejectReason: reason, decidedBy: a.userId, decidedAt: new Date() }).where(eq(bookings.id, b.id));
        await audit(tx, a, { action: 'booking.rejected', entityType: 'booking', entityId: b.id, reason, before: { status: b.status } });
        await emit(tx, a, 'booking.rejected', { bookingId: b.id, code: b.code });
        return this.decorate(tx, await this.load(tx, b.id));
      }),
    );
  }

  /** ไม่มารับตามนัด → ปล่อยของที่กันไว้ให้คนอื่น */
  @Post(':id/no-show')
  @HttpCode(200)
  async noShow(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string) {
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const b = await this.load(tx, id, true);
        if (b.status !== 'confirmed') throw new AppError(HttpStatus.CONFLICT, 'booking_closed', { status: b.status });
        await tx.update(bookingItems).set({ active: false }).where(eq(bookingItems.bookingId, b.id));
        await tx.update(bookings).set({ status: 'no_show', decidedBy: a.userId, decidedAt: new Date() }).where(eq(bookings.id, b.id));
        await audit(tx, a, { action: 'booking.no_show', entityType: 'booking', entityId: b.id });
        await emit(tx, a, 'booking.no_show', { bookingId: b.id, code: b.code });
        return this.decorate(tx, await this.load(tx, b.id));
      }),
    );
  }

  // ---------- helpers ----------

  private async load(tx: Tx, id: string, lock = false) {
    const q = tx.select().from(bookings).where(eq(bookings.id, id));
    const [b] = lock ? await q.for('update') : await q;
    if (!b) throw new AppError(HttpStatus.NOT_FOUND, 'booking_not_found');
    return b;
  }

  private async items(tx: Tx, bookingIds: string[]) {
    if (!bookingIds.length) return [];
    const rows = await tx
      .select({
        id: bookingItems.id,
        bookingId: bookingItems.bookingId,
        assetTypeId: bookingItems.assetTypeId,
        tracking: assetTypes.tracking,
        typeName: assetTypes.name,
        variantId: bookingItems.variantId,
        variantLabel: assetVariants.label,
        assetId: bookingItems.assetId,
        assetCode: assets.code,
        quantity: bookingItems.quantity,
        pricePerDay: bookingItems.pricePerDay,
        active: bookingItems.active,
      })
      .from(bookingItems)
      .innerJoin(assetTypes, eq(assetTypes.id, bookingItems.assetTypeId))
      .leftJoin(assetVariants, eq(assetVariants.id, bookingItems.variantId))
      .leftJoin(assets, eq(assets.id, bookingItems.assetId))
      .where(inArray(bookingItems.bookingId, bookingIds))
      .orderBy(asc(assetTypes.sortOrder), asc(bookingItems.id));
    return rows.map((r) => ({ ...r, label: r.variantLabel ? `${r.typeName} ${r.variantLabel} × ${r.quantity}` : r.typeName }));
  }

  private async rentalOverlaps(tx: Tx, assetId: string, start: Date, end: Date) {
    const r = await tx.execute(sql`
      select 1 from rental_items ri join rentals r on r.id = ri.rental_id
      where ri.asset_id = ${assetId} and ri.released_at is null
        and tstzrange(r.start_at, greatest(r.due_at, now())) && tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)
      limit 1`);
    return r.rows.length > 0;
  }

  /** คันที่ว่างตลอดช่วงของคำขอ (ใช้แนะนำตอนกำหนดคัน) */
  private async freeAssets(tx: Tx, typeId: string, start: Date, end: Date, ignoreBookingId: string) {
    const r = await tx.execute<{ id: string; code: string }>(sql`
      select a.id, a.code from assets a
      where a.asset_type_id = ${typeId} and a.status = 'available'
        and not exists (select 1 from rental_items ri join rentals r on r.id = ri.rental_id
          where ri.asset_id = a.id and ri.released_at is null
            and tstzrange(r.start_at, greatest(r.due_at, now())) && tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz))
        and not exists (select 1 from booking_items bi
          where bi.asset_id = a.id and bi.active and bi.booking_id <> ${ignoreBookingId}
            and bi.during && tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz))
      order by a.code`);
    return r.rows;
  }

  private async decorate(tx: Tx, b: BookingRow) {
    const { manageTokenHash: _hidden, ip: _ip, ...rest } = b;
    const items = await this.items(tx, [b.id]);
    const { start, end } = span(b);
    const suggestions: Record<string, Array<{ id: string; code: string }>> = {};
    const warnings: string[] = [];
    if (b.status === 'requested') {
      for (const typeId of [...new Set(items.filter((i) => i.tracking === 'unit').map((i) => i.assetTypeId))]) {
        const free = await this.freeAssets(tx, typeId, start, end, b.id);
        suggestions[typeId] = free;
        const need = items.filter((i) => i.assetTypeId === typeId).length;
        const name = items.find((i) => i.assetTypeId === typeId)!.typeName;
        if (free.length < need) warnings.push(`${name} ว่างไม่พอ (ว่าง ${free.length} · ขอ ${need})`);
        else if (free.length === need) warnings.push(`${name} เหลือคันสุดท้าย`);
      }
    }
    if (!b.hotelRoom) warnings.push('ลูกค้านอกโรงแรม · ควรเก็บมัดจำ');
    if (!b.hasLicense) warnings.push('ลูกค้าไม่ได้ยืนยันว่ามีใบขับขี่');
    const total = items.reduce((s, i) => s + i.pricePerDay * i.quantity * b.days, 0);
    return { ...rest, returnAt: end.toISOString(), items, suggestions, warnings, total };
  }

  /** หาลูกค้าเดิมจากเบอร์ WhatsApp · ไม่เจอสร้างใหม่จากข้อมูลในคำขอ */
  private async customerFor(tx: Tx, a: AuthCtx, b: BookingRow): Promise<string> {
    if (b.customerId) return b.customerId;
    // เบอร์สั้นเกินไป (พิมพ์มั่ว/ไม่ครบ) ไม่จับคู่ · เทียบ 9 หลักท้าย (+66 81… กับ 081… เป็นคนเดียวกัน)
    const digits = b.whatsapp.replace(/\D/g, '');
    const [found] =
      digits.length >= 8
        ? await tx
            .select({ id: customers.id })
            .from(customers)
            .where(sql`length(regexp_replace(coalesce(${customers.phone}, ''), '\\D', '', 'g')) >= 8
              and right(regexp_replace(coalesce(${customers.phone}, ''), '\\D', '', 'g'), 9) = right(${digits}, 9)`)
            .orderBy(asc(customers.createdAt))
            .limit(1)
        : [];
    if (found) {
      // คนนอกส่งคำขอได้ จึงห้ามทับข้อมูลลูกค้าเดิม · เติมเฉพาะช่องที่ยังว่าง
      await tx
        .update(customers)
        .set({
          hotelRoom: sql`coalesce(${customers.hotelRoom}, ${b.hotelRoom})`,
          checkoutDate: sql`coalesce(${customers.checkoutDate}, ${b.checkoutDate})`,
        })
        .where(eq(customers.id, found.id));
      return found.id;
    }
    const [c] = await tx
      .insert(customers)
      .values({ orgId: a.orgId, fullName: b.fullName, phone: b.whatsapp, email: b.email, hotelRoom: b.hotelRoom, checkoutDate: b.checkoutDate, createdBy: a.userId, notes: `จากคำขอจอง ${b.code}` })
      .returning({ id: customers.id });
    await audit(tx, a, { action: 'customer.created', entityType: 'customer', entityId: c!.id, after: { from: b.code } });
    return c!.id;
  }

  /** ชนกับคำขออื่นที่กันคันเดียวกันไว้ (กฎ booking_items_no_overlap ในฐานข้อมูล) */
  private async mapReserved<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const pe = pgError(e);
      if (pe.code === '23P01' || pe.message?.includes('booking_items_no_overlap')) throw new AppError(HttpStatus.CONFLICT, 'asset_reserved');
      throw e;
    }
  }
}
