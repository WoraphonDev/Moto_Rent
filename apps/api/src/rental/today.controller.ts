import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { assets, assetTypes, assetVariants, bills, customers, orgs, payments, rentalItems, rentals, withTenant, type Db } from '@rental/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB } from '../infra.js';
import { Auth, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';
import { billBalanceSql } from './billing.js';

/** หน้าหลักวันนี้ (mock 1.02 / 1.W1) · "วันนี้" ตามเขตเวลาของร้าน ไม่ใช่ของเซิร์ฟเวอร์ */
@Controller('v1/today')
@UseGuards(SessionGuard)
export class TodayController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async today(@Auth() a: AuthCtx) {
    return withTenant(this.db, a, async (tx) => {
      const [org] = await tx.select({ tz: orgs.timezone }).from(orgs).where(eq(orgs.id, a.orgId));
      const tz = org?.tz ?? 'Asia/Bangkok';
      const localToday = sql`(now() at time zone ${tz})::date`;
      const startOfDay = sql`(${localToday}::timestamp at time zone ${tz})`;
      const endOfDay = sql`((${localToday} + 1)::timestamp at time zone ${tz})`;

      const active = await tx
        .select({ id: rentals.id, dueAt: rentals.dueAt, startAt: rentals.startAt, customerId: customers.id, customerName: customers.fullName, hotelRoom: customers.hotelRoom, phone: customers.phone })
        .from(rentals)
        .innerJoin(customers, eq(customers.id, rentals.customerId))
        .where(eq(rentals.status, 'active'))
        .orderBy(asc(rentals.dueAt));
      // ป้ายของในแต่ละสัญญา เช่น "C-03" / "ชุดดำน้ำ L × 2"
      const labels = new Map<string, string[]>();
      if (active.length) {
        const items = await tx
          .select({ rentalId: rentalItems.rentalId, code: assets.code, typeName: assetTypes.name, size: assetVariants.label, qty: rentalItems.quantity })
          .from(rentalItems)
          .innerJoin(assetTypes, eq(assetTypes.id, rentalItems.assetTypeId))
          .leftJoin(assets, eq(assets.id, rentalItems.assetId))
          .leftJoin(assetVariants, eq(assetVariants.id, rentalItems.variantId))
          .where(and(inArray(rentalItems.rentalId, active.map((r) => r.id)), isNull(rentalItems.releasedAt)));
        for (const it of items) {
          const list = labels.get(it.rentalId) ?? [];
          list.push(it.code ?? `${it.typeName} ${it.size} × ${it.qty}`);
          labels.set(it.rentalId, list);
        }
      }
      const withItems = active.map((r) => ({ ...r, items: labels.get(r.id) ?? [] }));
      const now = Date.now();
      const [range] = (await tx.execute<{ start: string; end: string; date: string }>(sql`select ${startOfDay} as start, ${endOfDay} as end, ${localToday}::text as date`)).rows;
      const end = new Date(range!.end).getTime();

      const unpaidCheckouts = await tx
        .select({ billId: bills.id, customerId: customers.id, customerName: customers.fullName, hotelRoom: customers.hotelRoom, balance: sql<number>`${billBalanceSql}`.mapWith(Number) })
        .from(bills)
        .innerJoin(customers, eq(customers.id, bills.customerId))
        .where(and(eq(bills.status, 'open'), sql`${customers.checkoutDate} <= ${localToday}`, sql`${billBalanceSql} > 0`));

      const money = await tx
        .select({ method: payments.method, total: sql<number>`sum(${payments.amount})`.mapWith(Number) })
        .from(payments)
        .where(sql`${payments.createdAt} >= ${startOfDay} and ${payments.createdAt} < ${endOfDay}`)
        .groupBy(payments.method);

      return {
        date: range!.date,
        overdue: withItems.filter((r) => r.dueAt.getTime() < now),
        dueToday: withItems.filter((r) => r.dueAt.getTime() >= now && r.dueAt.getTime() < end),
        unpaidCheckouts,
        activeCount: active.length,
        moneyToday: money,
      };
    });
  }
}
