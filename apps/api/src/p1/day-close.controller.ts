import { Body, Controller, Get, HttpStatus, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { dayCloses, orgs, payments, users, withTenant, type Db, type Tx } from '@rental/db';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../common/audit.js';
import { dbCall } from '../common/db-errors.js';
import { AppError, parse } from '../common/http.js';
import { DB } from '../infra.js';
import { Auth, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';

const dateStr = z.string().date();
const closeBody = z.object({
  date: dateStr,
  countedCash: z.number().int().min(0).max(1_000_000_000),
  note: z.string().trim().max(500).optional(),
});

/** ปิดยอดสิ้นวัน (mock 1.W4 แผงขวา) · "วัน" ตามเขตเวลาของร้าน */
@Controller('v1/day-close')
@UseGuards(SessionGuard)
export class DayCloseController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async summary(@Auth() a: AuthCtx, @Query('date') date?: string) {
    if (date !== undefined) parse(dateStr, date);
    return withTenant(this.db, a, async (tx) => {
      const day = date ?? (await this.today(tx, a.orgId));
      const totals = await this.totals(tx, a.orgId, day);
      const [closed] = await tx
        .select({ c: dayCloses, by: users.displayName })
        .from(dayCloses)
        .innerJoin(users, eq(users.id, dayCloses.closedBy))
        .where(sql`${dayCloses.orgId} = ${a.orgId} and ${dayCloses.businessDate} = ${day}`);
      const recent = await tx
        .select({ c: dayCloses, by: users.displayName })
        .from(dayCloses)
        .innerJoin(users, eq(users.id, dayCloses.closedBy))
        .orderBy(desc(dayCloses.businessDate))
        .limit(14);
      return {
        date: day,
        today: await this.today(tx, a.orgId),
        byMethod: totals.byMethod,
        expectedCash: totals.cash,
        expectedOther: totals.other,
        closed: closed ? view(closed.c, closed.by) : null,
        recent: recent.map((r) => view(r.c, r.by)),
      };
    });
  }

  @Post()
  async close(@Auth() a: AuthCtx, @Body() body: unknown) {
    const input = parse(closeBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const today = await this.today(tx, a.orgId);
        if (input.date > today) throw new AppError(HttpStatus.BAD_REQUEST, 'future_date');
        // ยอดที่ระบบคาดคิดที่เซิร์ฟเวอร์เสมอ ไม่เชื่อตัวเลขจากเครื่อง
        const totals = await this.totals(tx, a.orgId, input.date);
        const [row] = await tx
          .insert(dayCloses)
          .values({ orgId: a.orgId, businessDate: input.date, expectedCash: totals.cash, countedCash: input.countedCash, expectedOther: totals.other, note: input.note ?? null, closedBy: a.userId })
          .returning();
        const difference = input.countedCash - totals.cash;
        await audit(tx, a, {
          action: 'day.closed',
          entityType: 'day_close',
          entityId: row!.id,
          after: { date: input.date, expectedCash: totals.cash, countedCash: input.countedCash, difference },
          reason: input.note ?? null,
          risk: difference !== 0 ? 'risky' : 'normal',
        });
        const [u] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, a.userId));
        return view(row!, u?.name ?? '');
      }),
    );
  }

  private async today(tx: Tx, orgId: string): Promise<string> {
    const [o] = await tx.select({ tz: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
    const r = await tx.execute<{ d: string }>(sql`select (now() at time zone ${o?.tz ?? 'Asia/Bangkok'})::date::text as d`);
    return r.rows[0]!.d;
  }

  private async totals(tx: Tx, orgId: string, day: string) {
    const [o] = await tx.select({ tz: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
    const tz = o?.tz ?? 'Asia/Bangkok';
    const rows = await tx
      .select({ method: payments.method, total: sql<number>`sum(${payments.amount})`.mapWith(Number), count: sql<number>`count(*)::int` })
      .from(payments)
      .where(
        sql`${payments.createdAt} >= (${day}::date::timestamp at time zone ${tz}) and ${payments.createdAt} < ((${day}::date + 1)::timestamp at time zone ${tz})`,
      )
      .groupBy(payments.method);
    const cash = rows.find((r) => r.method === 'cash')?.total ?? 0;
    const other = rows.filter((r) => r.method !== 'cash').reduce((s, r) => s + r.total, 0);
    return { byMethod: rows, cash, other };
  }
}

function view(c: typeof dayCloses.$inferSelect, by: string) {
  return {
    id: c.id,
    date: c.businessDate,
    expectedCash: c.expectedCash,
    countedCash: c.countedCash,
    difference: c.countedCash - c.expectedCash,
    expectedOther: c.expectedOther,
    note: c.note,
    closedBy: by,
    closedAt: c.closedAt,
  };
}
