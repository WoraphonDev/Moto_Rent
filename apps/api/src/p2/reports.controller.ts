import { Controller, Get, Inject, Query, Res, UseGuards } from '@nestjs/common';
import { assets, assetTypes, billLines, bills, customers, maintenanceRecords, payments, rentalItems, rentals, withTenant, type Db, type Tx } from '@rental/db';
import { and, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { DB } from '../infra.js';
import { Auth, Roles, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';
import { billBalanceSql } from '../rental/billing.js';
import { csv, dayRange, localToday, orgTimezone } from './common.js';

/**
 * รายงานเจ้าของ (mock 2.W1)
 *
 * หลักการนับเงิน
 * - "รายได้" = รายการในบิลที่ "เกิด" ในช่วงที่เลือก (ตามเวลาที่บันทึกรายการ · แบบเกณฑ์คงค้าง) ไม่นับบิลที่ยกเลิก
 *   ส่วนลดเป็นยอดติดลบ จึงหักออกจากรายได้เอง
 * - "เงินเข้า" = การรับเงินในช่วงที่เลือก (เกณฑ์เงินสด) ไม่นับบิลที่ยกเลิก
 *
 * การแบ่งรายได้ลงรถแต่ละคัน / แต่ละประเภท
 * รายการในบิลผูกกับสัญญา (rental_id) ไม่ได้ผูกกับของแต่ละชิ้น · สัญญาที่มีของชิ้นเดียว (กรณีส่วนใหญ่) แบ่งได้ตรง 100%
 * สัญญาที่มีหลายชิ้น แบ่งยอดตามสัดส่วน "ราคาต่อวัน × จำนวน" ของแต่ละชิ้น (ค่าเช่า ต่อวัน คืนช้า คำนวณจากราคานี้อยู่แล้ว
 * จึงตรงสำหรับรายการเหล่านั้น · ค่าน้ำมัน/ค่าเสียหาย/ส่วนลดที่ผูกกับสัญญาหลายชิ้นเป็นค่าประมาณ)
 * รายการที่ไม่ผูกกับสัญญา (ส่วนลดหรือค่าอื่นระดับบิล) ไม่ถูกแบ่งลงรถ แต่ยังอยู่ในยอดรายได้รวม (แสดงเป็น "ไม่ระบุรถ")
 */
@Controller('v1/reports')
@UseGuards(SessionGuard)
@Roles('owner', 'manager')
export class ReportsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('summary')
  async summary(@Auth() a: AuthCtx, @Query('from') from?: string, @Query('to') to?: string) {
    return withTenant(this.db, a, (tx) => this.build(tx, a, from, to));
  }

  @Get('summary.csv')
  async summaryCsv(@Auth() a: AuthCtx, @Res() res: Response, @Query('from') from?: string, @Query('to') to?: string) {
    const r = await withTenant(this.db, a, (tx) => this.build(tx, a, from, to));
    const baht = (m: number) => (m / 100).toFixed(2);
    const rows: unknown[][] = [
      ['รายงาน', `${r.range.from} ถึง ${r.range.to}`],
      [],
      ['รายได้ตามประเภทรายการ', 'บาท'],
      ...r.revenueByKind.map((k) => [k.kind, baht(k.amount)]),
      ['รวม', baht(r.totals.revenue)],
      [],
      ['เงินเข้าตามวิธีจ่าย', 'บาท'],
      ...r.paymentsByMethod.map((p) => [p.method, baht(p.amount)]),
      [],
      ['รายวัน', 'รายได้ (บาท)', 'เงินเข้า (บาท)'],
      ...r.daily.map((d) => [d.date, baht(d.revenue), baht(d.payments)]),
      [],
      ['ประเภทของให้เช่า', 'รายได้ (บาท)'],
      ...r.revenueByType.map((t) => [t.name, baht(t.revenue)]),
      [],
      ['รหัส', 'ประเภท', 'รายได้ (บาท)', 'ค่าซ่อม (บาท)', 'กำไร (บาท)', 'อัตราใช้งาน (%)', 'ชั่วโมงที่ถูกเช่า'],
      ...r.assets.map((x) => [x.code, x.typeName, baht(x.revenue), baht(x.maintenanceCost), baht(x.profit), x.utilizationPct, x.rentedHours]),
    ];
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="report-${r.range.from}-${r.range.to}.csv"`);
    res.setHeader('cache-control', 'no-store');
    res.send(csv(rows));
  }

  private async build(tx: Tx, a: AuthCtx, fromQ?: string, toQ?: string) {
    const tz = await orgTimezone(tx, a.orgId);
    const today = await localToday(tx, tz);
    const range = await dayRange(tx, tz, fromQ ?? today, toQ ?? fromQ ?? today);
    const { start, end } = range;
    const notVoid = ne(bills.status, 'void');

    // ---------- รายได้ตามประเภทรายการ ----------
    const byKind = await tx
      .select({ kind: billLines.kind, amount: sql<number>`sum(${billLines.amount})`.mapWith(Number) })
      .from(billLines)
      .innerJoin(bills, eq(bills.id, billLines.billId))
      .where(and(gte(billLines.createdAt, start), lt(billLines.createdAt, end), notVoid))
      .groupBy(billLines.kind);

    // ---------- เงินเข้าตามวิธีจ่าย ----------
    const byMethod = await tx
      .select({ method: payments.method, amount: sql<number>`sum(${payments.amount})`.mapWith(Number), count: sql<number>`count(*)::int` })
      .from(payments)
      .innerJoin(bills, eq(bills.id, payments.billId))
      .where(and(gte(payments.createdAt, start), lt(payments.createdAt, end), notVoid))
      .groupBy(payments.method);

    // ---------- รายวัน (วันตามเขตเวลาร้าน · เติมวันที่ไม่มีรายการเป็น 0) ----------
    const dayOf = (col: typeof billLines.createdAt | typeof payments.createdAt) => sql<string>`(${col} at time zone ${tz})::date::text`;
    const revDays = await tx
      .select({ d: dayOf(billLines.createdAt), v: sql<number>`sum(${billLines.amount})`.mapWith(Number) })
      .from(billLines)
      .innerJoin(bills, eq(bills.id, billLines.billId))
      .where(and(gte(billLines.createdAt, start), lt(billLines.createdAt, end), notVoid))
      // จัดกลุ่มด้วยลำดับคอลัมน์: นิพจน์มีพารามิเตอร์เขตเวลา จึงเขียนซ้ำใน GROUP BY ไม่ได้ (เป็นคนละพารามิเตอร์)
      .groupBy(sql`1`);
    const payDays = await tx
      .select({ d: dayOf(payments.createdAt), v: sql<number>`sum(${payments.amount})`.mapWith(Number) })
      .from(payments)
      .innerJoin(bills, eq(bills.id, payments.billId))
      .where(and(gte(payments.createdAt, start), lt(payments.createdAt, end), notVoid))
      .groupBy(sql`1`);
    const rev = new Map(revDays.map((r) => [r.d, r.v]));
    const pay = new Map(payDays.map((r) => [r.d, r.v]));
    const daily: Array<{ date: string; revenue: number; payments: number }> = [];
    for (let d = range.from; d <= range.to; d = nextDay(d)) daily.push({ date: d, revenue: rev.get(d) ?? 0, payments: pay.get(d) ?? 0 });

    // ---------- แบ่งรายได้ลงของแต่ละชิ้น ----------
    const lines = await tx
      .select({ rentalId: billLines.rentalId, amount: billLines.amount })
      .from(billLines)
      .innerJoin(bills, eq(bills.id, billLines.billId))
      .where(and(gte(billLines.createdAt, start), lt(billLines.createdAt, end), notVoid, sql`${billLines.rentalId} is not null`));
    const rentalIds = [...new Set(lines.map((l) => l.rentalId!))];
    const items = rentalIds.length
      ? await tx
          .select({ rentalId: rentalItems.rentalId, assetId: rentalItems.assetId, typeId: rentalItems.assetTypeId, weight: sql<number>`(${rentalItems.pricePerDay} * ${rentalItems.quantity})`.mapWith(Number) })
          .from(rentalItems)
          .where(inArray(rentalItems.rentalId, rentalIds))
      : [];
    const byRental = new Map<string, typeof items>();
    for (const it of items) byRental.set(it.rentalId, [...(byRental.get(it.rentalId) ?? []), it]);
    const assetRevenue = new Map<string, number>();
    const typeRevenue = new Map<string, number>();
    let unattributed = 0;
    for (const l of lines) {
      const its = byRental.get(l.rentalId!) ?? [];
      const total = its.reduce((s, i) => s + i.weight, 0);
      if (!its.length || total <= 0) {
        unattributed += l.amount;
        continue;
      }
      // แบ่งตามสัดส่วน · ชิ้นสุดท้ายรับเศษ ให้ผลรวมเท่ายอดจริงพอดี
      let left = l.amount;
      its.forEach((i, idx) => {
        const share = idx === its.length - 1 ? left : Math.round((l.amount * i.weight) / total);
        left -= share;
        typeRevenue.set(i.typeId, (typeRevenue.get(i.typeId) ?? 0) + share);
        if (i.assetId) assetRevenue.set(i.assetId, (assetRevenue.get(i.assetId) ?? 0) + share);
      });
    }
    const levelRevenue = byKind.reduce((s, k) => s + k.amount, 0);
    const linesTotal = lines.reduce((s, l) => s + l.amount, 0);
    unattributed += levelRevenue - linesTotal; // รายการระดับบิล (ไม่ผูกสัญญา)

    const types = await tx.select({ id: assetTypes.id, name: assetTypes.name, tracking: assetTypes.tracking }).from(assetTypes);
    const revenueByType = types
      .map((t) => ({ typeId: t.id, name: t.name, tracking: t.tracking, revenue: typeRevenue.get(t.id) ?? 0 }))
      .filter((t) => t.revenue !== 0)
      .sort((x, y) => y.revenue - x.revenue);

    // ---------- อัตราใช้งานของรถแต่ละคัน: ชั่วโมงที่ถูกเช่า (ตัดให้อยู่ในช่วง) ÷ ชั่วโมงทั้งหมดของช่วง ----------
    // ช่วงยังไม่จบ (ถึงวันนี้) นับถึงตอนนี้ ไม่นับเวลาในอนาคต
    const now = new Date();
    const effEnd = end > now ? now : end;
    const totalHours = Math.max(0, (effEnd.getTime() - start.getTime()) / 3_600_000);
    const usage = await tx
      .select({
        assetId: rentalItems.assetId,
        hours: sql<number>`sum(greatest(0, extract(epoch from (least(coalesce(${rentalItems.releasedAt}, ${effEnd}::timestamptz), ${effEnd}::timestamptz) - greatest(${rentals.startAt}, ${start}::timestamptz))) / 3600))`.mapWith(Number),
      })
      .from(rentalItems)
      .innerJoin(rentals, eq(rentals.id, rentalItems.rentalId))
      .where(
        and(
          sql`${rentalItems.assetId} is not null`,
          ne(rentals.status, 'cancelled'),
          lt(rentals.startAt, effEnd),
          sql`coalesce(${rentalItems.releasedAt}, 'infinity'::timestamptz) > ${start}::timestamptz`,
        ),
      )
      .groupBy(rentalItems.assetId);
    const hoursBy = new Map(usage.map((u) => [u.assetId!, u.hours]));

    const maint = await tx
      .select({ assetId: maintenanceRecords.assetId, cost: sql<number>`sum(${maintenanceRecords.cost})`.mapWith(Number) })
      .from(maintenanceRecords)
      .where(and(gte(maintenanceRecords.performedOn, range.from), lt(maintenanceRecords.performedOn, sql`(${range.to}::date + 1)`)))
      .groupBy(maintenanceRecords.assetId);
    const maintBy = new Map(maint.map((m) => [m.assetId, m.cost]));

    const unitAssets = await tx
      .select({ id: assets.id, code: assets.code, typeName: assetTypes.name, status: assets.status })
      .from(assets)
      .innerJoin(assetTypes, eq(assetTypes.id, assets.assetTypeId))
      .orderBy(assets.code);
    const assetRows = unitAssets
      .filter((x) => x.status !== 'retired' || assetRevenue.has(x.id) || maintBy.has(x.id))
      .map((x) => {
        const revenue = assetRevenue.get(x.id) ?? 0;
        const maintenanceCost = maintBy.get(x.id) ?? 0;
        const rentedHours = Math.round((hoursBy.get(x.id) ?? 0) * 10) / 10;
        return {
          assetId: x.id,
          code: x.code,
          typeName: x.typeName,
          revenue,
          maintenanceCost,
          profit: revenue - maintenanceCost,
          rentedHours,
          utilizationPct: totalHours > 0 ? Math.min(100, Math.round((rentedHours / totalHours) * 1000) / 10) : 0,
        };
      });

    // ---------- บิลค้างทั้งหมด (ณ ตอนนี้ ไม่ขึ้นกับช่วง) ----------
    const [open] = await tx
      .select({ total: sql<number>`coalesce(sum(${billBalanceSql}), 0)`.mapWith(Number), count: sql<number>`count(*)::int` })
      .from(bills)
      .where(eq(bills.status, 'open'));

    // ---------- ลูกค้ามาจากไหน (สัญญาที่เริ่มในช่วง) ----------
    const channels = await tx
      .select({
        channel: rentals.channel,
        hotelGuest: sql<boolean>`${customers.hotelRoom} is not null`,
        count: sql<number>`count(*)::int`,
      })
      .from(rentals)
      .innerJoin(customers, eq(customers.id, rentals.customerId))
      .where(and(gte(rentals.startAt, start), lt(rentals.startAt, end), ne(rentals.status, 'cancelled')))
      .groupBy(sql`1`, sql`2`);

    const paymentsTotal = byMethod.reduce((s, m) => s + m.amount, 0);
    const assetCount = assetRows.filter((x) => unitAssets.find((u) => u.id === x.assetId)?.status !== 'retired').length;
    return {
      range: { from: range.from, to: range.to, timezone: tz, hours: Math.round(totalHours * 10) / 10 },
      totals: {
        revenue: levelRevenue,
        payments: paymentsTotal,
        openBills: open?.total ?? 0,
        openBillCount: open?.count ?? 0,
        rentals: channels.reduce((s, c) => s + c.count, 0),
        unattributedRevenue: unattributed,
        maintenanceCost: maint.reduce((s, m) => s + m.cost, 0),
        avgUtilizationPct: assetCount ? Math.round((assetRows.reduce((s, x) => s + x.utilizationPct, 0) / assetRows.length) * 10) / 10 : 0,
      },
      revenueByKind: byKind.sort((x, y) => y.amount - x.amount),
      paymentsByMethod: byMethod.sort((x, y) => y.amount - x.amount),
      daily,
      revenueByType,
      assets: assetRows.sort((x, y) => y.profit - x.profit),
      channels: {
        byChannel: Object.entries(
          channels.reduce<Record<string, number>>((m, c) => ((m[c.channel] = (m[c.channel] ?? 0) + c.count), m), {}),
        ).map(([channel, count]) => ({ channel, count })),
        hotelGuests: channels.filter((c) => c.hotelGuest).reduce((s, c) => s + c.count, 0),
        nonHotel: channels.filter((c) => !c.hotelGuest).reduce((s, c) => s + c.count, 0),
      },
    };
  }
}

function nextDay(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}
