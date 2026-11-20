import { Body, Controller, Get, HttpStatus, Inject, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common';
import { memberships, orgs, orgSettings, users, withTenant, type Db } from '@rental/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../common/audit.js';
import { dbCall } from '../common/db-errors.js';
import { AppError, parse } from '../common/http.js';
import { DB } from '../infra.js';
import { Auth, Roles, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';

const money = z.number().int().min(0).max(100_000_000);
const settingsBody = z
  .object({
    lateGraceMinutes: z.number().int().min(0).max(1440),
    lateHalfDayUntilMinutes: z.number().int().min(0).max(1440),
    maxRentalDays: z.number().int().min(1).max(365).nullable(),
    depositNonGuest: money.nullable(),
    staffDiscountCap: money,
    docRetentionDays: z.number().int().min(1).max(3650),
    idleLockMinutes: z.number().int().min(1).max(240),
    /** เปิดหน้าจองออนไลน์ของร้าน (ร้านใหม่ปิดไว้ก่อน) */
    publicBookingEnabled: z.boolean(),
  })
  .partial();
const orgBody = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  timezone: z
    .string()
    .trim()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'timezone_invalid')
    .optional(),
});
const limitBody = z.object({ limit: money.nullable() });

/** ตั้งค่าร้าน: กฎ · ข้อมูลร้าน · เพดานส่วนลดรายคน (mock 2.03 / 2.W4) */
@Controller('v1')
@UseGuards(SessionGuard)
export class SettingsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('settings')
  async get(@Auth() a: AuthCtx) {
    return withTenant(this.db, a, async (tx) => {
      const [base] = await tx.select().from(orgSettings).where(eq(orgSettings.orgId, a.orgId));
      const s = base ? { ...base, publicBookingEnabled: await bookingEnabled(tx, a.orgId) } : base;
      const [o] = await tx.select({ id: orgs.id, name: orgs.name, slug: orgs.slug, timezone: orgs.timezone, currency: orgs.currency }).from(orgs).where(eq(orgs.id, a.orgId));
      const staff =
        a.role === 'owner' || a.role === 'manager'
          ? await tx
              .select({ userId: users.id, displayName: users.displayName, username: users.username, role: memberships.role, discountLimit: memberships.discountLimit })
              .from(memberships)
              .innerJoin(users, eq(users.id, memberships.userId))
              .where(and(eq(memberships.orgId, a.orgId), eq(memberships.status, 'active')))
              .orderBy(memberships.createdAt)
          : [];
      return { settings: s, org: o, staff };
    });
  }

  @Patch('settings')
  @Roles('owner')
  async patch(@Auth() a: AuthCtx, @Body() body: unknown) {
    const input = parse(settingsBody, body);
    if (!Object.keys(input).length) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_input');
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [before] = await tx.select().from(orgSettings).where(eq(orgSettings.orgId, a.orgId));
        if (!before) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        const grace = input.lateGraceMinutes ?? before.lateGraceMinutes;
        const half = input.lateHalfDayUntilMinutes ?? before.lateHalfDayUntilMinutes;
        if (half < grace) throw new AppError(HttpStatus.BAD_REQUEST, 'half_day_before_grace');
        // คอลัมน์ public_booking_enabled เพิ่มด้วย SQL (migration 0009) จึงอัปเดตแยก
        const { publicBookingEnabled, ...cols } = input;
        const bookingBefore = await bookingEnabled(tx, a.orgId);
        const [updated] = await tx.update(orgSettings).set({ ...cols, updatedAt: new Date() }).where(eq(orgSettings.orgId, a.orgId)).returning();
        if (publicBookingEnabled !== undefined) {
          await tx.execute(sql`update org_settings set public_booking_enabled = ${publicBookingEnabled} where org_id = ${a.orgId}`);
        }
        const row = { ...updated!, publicBookingEnabled: await bookingEnabled(tx, a.orgId) };
        const changed = Object.fromEntries(
          Object.keys(input).map((k) => [k, k === 'publicBookingEnabled' ? bookingBefore : (before as Record<string, unknown>)[k]]),
        );
        await audit(tx, a, {
          action: 'settings.updated',
          entityType: 'org_settings',
          entityId: a.orgId,
          before: changed,
          after: input,
          // เพิ่มเพดานส่วนลด = ให้พนักงานลดได้มากขึ้น · เจ้าของควรเห็นชัดในประวัติ
          risk: input.staffDiscountCap !== undefined && input.staffDiscountCap > before.staffDiscountCap ? 'risky' : 'normal',
        });
        return row;
      }),
    );
  }

  @Patch('orgs/current')
  @Roles('owner')
  async org(@Auth() a: AuthCtx, @Body() body: unknown) {
    const input = parse(orgBody, body);
    if (!Object.keys(input).length) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_input');
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [before] = await tx.select({ name: orgs.name, timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, a.orgId));
        const [row] = await tx.update(orgs).set(input).where(eq(orgs.id, a.orgId)).returning({ id: orgs.id, name: orgs.name, timezone: orgs.timezone, slug: orgs.slug });
        await audit(tx, a, { action: 'org.updated', entityType: 'org', entityId: a.orgId, before, after: input });
        return row;
      }),
    );
  }

  @Patch('members/:userId/discount-limit')
  @Roles('owner')
  async discountLimit(@Auth() a: AuthCtx, @Param('userId', ParseUUIDPipe) userId: string, @Body() body: unknown) {
    const { limit } = parse(limitBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [m] = await tx
          .select({ limit: memberships.discountLimit, role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.orgId, a.orgId), eq(memberships.userId, userId), eq(memberships.status, 'active')));
        if (!m) throw new AppError(HttpStatus.NOT_FOUND, 'member_not_found');
        await tx
          .update(memberships)
          .set({ discountLimit: limit })
          .where(and(eq(memberships.orgId, a.orgId), eq(memberships.userId, userId)));
        await audit(tx, a, {
          action: 'member.discount_limit_changed',
          entityType: 'user',
          entityId: userId,
          before: { discountLimit: m.limit },
          after: { discountLimit: limit },
          risk: limit !== null && (m.limit === null || limit > m.limit) ? 'risky' : 'normal',
        });
        return { userId, discountLimit: limit };
      }),
    );
  }
}

/** สถานะหน้าจองออนไลน์ของร้าน (อ่านใต้ RLS ของร้านนี้) */
async function bookingEnabled(tx: Parameters<Parameters<typeof withTenant>[2]>[0], orgId: string): Promise<boolean> {
  const r = await tx.execute<{ v: boolean }>(sql`select public_booking_enabled as v from org_settings where org_id = ${orgId}`);
  return !!r.rows[0]?.v;
}
