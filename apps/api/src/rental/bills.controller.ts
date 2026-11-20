import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { billLines, bills, customers, payments, users, withTenant, type Db, type Tx } from '@rental/db';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../common/audit.js';
import { dbCall } from '../common/db-errors.js';
import { AppError, parse } from '../common/http.js';
import { DB } from '../infra.js';
import { Auth, Roles, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';
import { addLine, billBalanceSql, billTotals, lockBill, settingsOf, settleIfZero } from './billing.js';

const lineBody = z.object({
  kind: z.enum(['discount', 'gear', 'fuel', 'damage', 'other']),
  description: z.string().trim().min(1).max(120),
  /** จำนวนเงินเป็นบวกเสมอ (หน่วยย่อย) · ส่วนลดระบบแปลงเป็นยอดลบเอง */
  amount: z.number().int().min(1).max(100_000_000),
  reason: z.string().trim().min(2).max(300).optional(),
});
const payBody = z.object({
  payments: z
    .array(
      z.object({
        method: z.enum(['cash', 'promptpay', 'transfer', 'card']),
        amount: z.number().int().min(1).max(100_000_000),
        /** id จากเครื่อง · ส่งซ้ำ (โหมดออฟไลน์) แล้วไม่รับเงินซ้ำ */
        clientId: z.string().uuid().optional(),
      }),
    )
    .min(1)
    .max(4),
});
const voidBody = z.object({ reason: z.string().trim().min(2).max(300) });

/** บิลค้าง + รับเงิน (mock 1.07 / 1.W4) */
@Controller('v1/bills')
@UseGuards(SessionGuard)
export class BillsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Auth() a: AuthCtx, @Query('status') status?: string) {
    const st = status === 'paid' || status === 'void' ? status : 'open';
    return withTenant(this.db, a, (tx) =>
      tx
        .select({
          id: bills.id,
          status: bills.status,
          receiptNo: bills.receiptNo,
          paidAt: bills.paidAt,
          createdAt: bills.createdAt,
          customerId: customers.id,
          customerName: customers.fullName,
          hotelRoom: customers.hotelRoom,
          checkoutDate: customers.checkoutDate,
          total: sql<number>`(select coalesce(sum(l.amount), 0) from bill_lines l where l.bill_id = ${bills.id})`.mapWith(Number),
          balance: sql<number>`${billBalanceSql}`.mapWith(Number),
        })
        .from(bills)
        .innerJoin(customers, eq(customers.id, bills.customerId))
        .where(eq(bills.status, st))
        .orderBy(st === 'open' ? asc(customers.checkoutDate) : desc(bills.paidAt))
        .limit(200),
    );
  }

  @Get(':id')
  async detail(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string) {
    return withTenant(this.db, a, (tx) => this.detailIn(tx, id));
  }

  @Post(':id/lines')
  async addLine(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(lineBody, body);
    if ((input.kind === 'discount' || input.kind === 'other') && !input.reason) throw new AppError(HttpStatus.BAD_REQUEST, 'reason_required');
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        // ล็อกบิลก่อน: สองเครื่องลดราคา/รับเงินพร้อมกันต้องเห็นยอดล่าสุดของกันและกัน
        const bill = await lockBill(tx, id);
        if (!bill) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        if (bill.status !== 'open') throw new AppError(HttpStatus.CONFLICT, 'bill_closed');
        if (input.kind === 'discount') {
          const { balance } = await billTotals(tx, id);
          if (input.amount > balance) throw new AppError(HttpStatus.CONFLICT, 'discount_exceeds_balance', { balance });
        }
        const amount = input.kind === 'discount' ? -input.amount : input.amount;
        const line = await addLine(tx, a, { billId: id, kind: input.kind, description: input.description, amount, reason: input.reason ?? null });
        const cap = (await settingsOf(tx, a.orgId)).staffDiscountCap;
        await audit(tx, a, {
          action: input.kind === 'discount' ? 'bill.discount' : 'bill.line_added',
          entityType: 'bill',
          entityId: id,
          after: { kind: input.kind, description: input.description, amount },
          reason: input.reason ?? null,
          risk: input.kind === 'discount' && input.amount > cap ? 'risky' : 'normal',
        });
        // ลดจนยอดค้างเป็น 0 = ปิดบิลพร้อมใบเสร็จ
        if (input.kind === 'discount') await settleIfZero(tx, a, id, bill.customerId);
        return line;
      }),
    );
  }

  /** รับเงิน · แยกจ่ายหลายวิธีได้ · ครบยอดแล้วออกเลขใบเสร็จ */
  @Post(':id/payments')
  @HttpCode(200)
  async pay(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(payBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        // ล็อกแถวบิลก่อน แล้วค่อยอ่านยอด (คำสั่งแยก) · ถ้าอ่านยอดในคำสั่งเดียวกับ FOR UPDATE
        // เครื่องที่รอล็อกจะได้ยอดก่อนอีกเครื่อง commit → รับเงินเกิน หรือบิลไม่ปิดทั้งที่ยอดเป็น 0
        const bill = await lockBill(tx, id);
        if (!bill) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        // ส่งซ้ำจากโหมดออฟไลน์: เคยรับรายการนี้แล้ว → คืนบิลปัจจุบันโดยไม่รับเงินซ้ำ
        const clientIds = input.payments.map((p) => p.clientId).filter((x): x is string => !!x);
        if (clientIds.length) {
          const seen = await tx.select({ id: payments.id }).from(payments).where(and(eq(payments.billId, id), inArray(payments.clientId, clientIds)));
          if (seen.length) return this.detailIn(tx, id);
        }
        if (bill.status !== 'open') throw new AppError(HttpStatus.CONFLICT, 'bill_closed');
        const { balance } = await billTotals(tx, id);
        const paying = input.payments.reduce((s, p) => s + p.amount, 0);
        if (paying > balance) throw new AppError(HttpStatus.BAD_REQUEST, 'overpayment', { balance });
        await tx.insert(payments).values(input.payments.map((p) => ({ orgId: a.orgId, billId: id, method: p.method, amount: p.amount, receivedBy: a.userId, clientId: p.clientId ?? null })));
        const remaining = balance - paying;
        const receiptNo = remaining === 0 ? await settleIfZero(tx, a, id, bill.customerId) : null;
        await audit(tx, a, { action: 'bill.payment', entityType: 'bill', entityId: id, after: { payments: input.payments, remaining, receiptNo } });
        return this.detailIn(tx, id);
      }),
    );
  }

  @Post(':id/void')
  @HttpCode(200)
  @Roles('owner')
  async void(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parse(voidBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [b] = await tx.select({ status: bills.status }).from(bills).where(eq(bills.id, id));
        if (!b) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        await tx.update(bills).set({ status: 'void', voidedAt: new Date(), voidReason: reason }).where(eq(bills.id, id));
        await audit(tx, a, { action: 'bill.voided', entityType: 'bill', entityId: id, before: { status: b.status }, reason, risk: 'risky' });
        return this.detailIn(tx, id);
      }),
    );
  }

  private async detailIn(tx: Tx, id: string) {
    const [b] = await tx
      .select({ bill: bills, customer: { id: customers.id, fullName: customers.fullName, hotelRoom: customers.hotelRoom, phone: customers.phone, checkoutDate: customers.checkoutDate } })
      .from(bills)
      .innerJoin(customers, eq(customers.id, bills.customerId))
      .where(eq(bills.id, id));
    if (!b) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
    const lines = await tx
      .select({ id: billLines.id, rentalId: billLines.rentalId, kind: billLines.kind, description: billLines.description, amount: billLines.amount, reason: billLines.reason, createdAt: billLines.createdAt, by: users.displayName })
      .from(billLines)
      .innerJoin(users, eq(users.id, billLines.createdBy))
      .where(eq(billLines.billId, id))
      .orderBy(asc(billLines.createdAt));
    const paid = await tx
      .select({ id: payments.id, method: payments.method, amount: payments.amount, createdAt: payments.createdAt, by: users.displayName })
      .from(payments)
      .innerJoin(users, eq(users.id, payments.receivedBy))
      .where(eq(payments.billId, id))
      .orderBy(asc(payments.createdAt));
    const total = lines.reduce((s, l) => s + l.amount, 0);
    const paidTotal = paid.reduce((s, p) => s + p.amount, 0);
    const balance = total - paidTotal;
    // ยอดติดลบ = ลูกค้าจ่ายเกิน (เช่น ยกเลิกสัญญาหลังจ่ายแล้ว) · ต้องคืนเงินนอกระบบ แสดงให้พนักงานเห็น
    return { ...b.bill, customer: b.customer, lines, payments: paid, total, paid: paidTotal, balance, refundDue: balance < 0 ? -balance : 0 };
  }
}
