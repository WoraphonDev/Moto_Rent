import { Body, Controller, Get, HttpStatus, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { bills, customers, rentals, withTenant, type Db } from '@rental/db';
import { desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../common/audit.js';
import { dbCall } from '../common/db-errors.js';
import { AppError, parse } from '../common/http.js';
import { DB } from '../infra.js';
import { Auth, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';
import { billBalanceSql } from './billing.js';

const customerBody = z.object({
  fullName: z.string().trim().min(1).max(100),
  nationality: z.string().trim().max(40).optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{6,20}$/, 'phone_format')
    .optional(),
  email: z.string().trim().email().max(120).optional(),
  hotelRoom: z.string().trim().max(10).optional(),
  checkoutDate: z.string().date().optional(),
  notes: z.string().trim().max(1000).optional(),
});
/** ตอนแก้ไข ช่องที่ไม่บังคับส่งสตริงว่างหรือ null มา = ล้างค่าเดิม */
const clearable = <T extends z.ZodTypeAny>(t: T) => z.preprocess((v) => (v === '' ? null : v), t.nullable().optional());
const customerPatch = z.object({
  fullName: customerBody.shape.fullName.optional(),
  nationality: clearable(z.string().trim().max(40)),
  phone: clearable(z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, 'phone_format')),
  email: clearable(z.string().trim().email().max(120)),
  hotelRoom: clearable(z.string().trim().max(10)),
  checkoutDate: clearable(z.string().date()),
  notes: clearable(z.string().trim().max(1000)),
}).extend({
  doNotRent: z.boolean().optional(),
  doNotRentReason: z.string().trim().max(300).nullable().optional(),
});

/** ลูกค้า (mock 1.10 / 1.W6) */
@Controller('v1/customers')
@UseGuards(SessionGuard)
export class CustomersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** ค้นจากชื่อ ห้อง หรือเบอร์ · ไม่ใส่คำค้น = ลูกค้าล่าสุด */
  @Get()
  async search(@Auth() a: AuthCtx, @Query('q') q?: string) {
    const term = (q ?? '').trim().slice(0, 60);
    return withTenant(this.db, a, (tx) =>
      tx
        .select({
          id: customers.id,
          fullName: customers.fullName,
          nationality: customers.nationality,
          phone: customers.phone,
          hotelRoom: customers.hotelRoom,
          checkoutDate: customers.checkoutDate,
          doNotRent: customers.doNotRent,
          openBillId: bills.id,
          balance: sql<number>`coalesce(${billBalanceSql}, 0)`.mapWith(Number),
        })
        .from(customers)
        .leftJoin(bills, sql`${bills.customerId} = ${customers.id} and ${bills.status} = 'open'`)
        .where(
          term
            ? or(ilike(customers.fullName, `%${escapeLike(term)}%`), eq(customers.hotelRoom, term), ilike(customers.phone, `%${escapeLike(term)}%`))
            : undefined,
        )
        .orderBy(desc(customers.createdAt))
        .limit(30),
    );
  }

  @Post()
  async create(@Auth() a: AuthCtx, @Body() body: unknown) {
    const input = parse(customerBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [row] = await tx.insert(customers).values({ orgId: a.orgId, createdBy: a.userId, ...input }).returning();
        await audit(tx, a, { action: 'customer.created', entityType: 'customer', entityId: row!.id });
        return row;
      }),
    );
  }

  @Get(':id')
  async detail(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string) {
    return withTenant(this.db, a, async (tx) => {
      const [c] = await tx.select().from(customers).where(eq(customers.id, id));
      if (!c) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
      const history = await tx
        .select({ id: rentals.id, status: rentals.status, startAt: rentals.startAt, dueAt: rentals.dueAt, returnedAt: rentals.returnedAt })
        .from(rentals)
        .where(eq(rentals.customerId, id))
        .orderBy(desc(rentals.startAt))
        .limit(50);
      const [openBill] = await tx
        .select({ id: bills.id, balance: sql<number>`${billBalanceSql}`.mapWith(Number) })
        .from(bills)
        .where(sql`${bills.customerId} = ${id} and ${bills.status} = 'open'`);
      return { ...c, rentals: history, openBill: openBill ?? null };
    });
  }

  @Patch(':id')
  async patch(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(customerPatch, body);
    if (input.doNotRent && !input.doNotRentReason) throw new AppError(HttpStatus.BAD_REQUEST, 'reason_required');
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [before] = await tx.select().from(customers).where(eq(customers.id, id));
        if (!before) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        const patch = input.doNotRent === false ? { ...input, doNotRentReason: null } : input;
        const [row] = await tx.update(customers).set(patch).where(eq(customers.id, id)).returning();
        const flagChanged = input.doNotRent !== undefined && input.doNotRent !== before.doNotRent;
        await audit(tx, a, {
          action: flagChanged ? (input.doNotRent ? 'customer.flagged_do_not_rent' : 'customer.unflagged') : 'customer.updated',
          entityType: 'customer',
          entityId: id,
          reason: input.doNotRentReason ?? null,
          risk: flagChanged ? 'risky' : 'normal',
        });
        return row;
      }),
    );
  }
}

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
