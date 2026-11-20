import { HttpStatus } from '@nestjs/common';
import { billLines, bills, orgs, orgSettings, outboxEvents, type Tx } from '@rental/db';
import { eq, sql } from 'drizzle-orm';
import type { AuthCtx } from '../auth/context.js';
import { AppError } from '../common/http.js';

/** ยอดคงค้างของบิล = รวมรายการ − รวมเงินที่รับแล้ว (ใช้ในคำสั่งที่ select จากตาราง bills) */
export const billBalanceSql = sql`((select coalesce(sum(l.amount), 0) from bill_lines l where l.bill_id = ${bills.id})
  - (select coalesce(sum(p.amount), 0) from payments p where p.bill_id = ${bills.id}))`;

/** บิลเปิดของลูกค้า · ไม่มีก็สร้าง (unique index กันสองเครื่องสร้างพร้อมกัน) */
export async function openBillFor(tx: Tx, a: AuthCtx, customerId: string): Promise<string> {
  await tx.insert(bills).values({ orgId: a.orgId, customerId }).onConflictDoNothing();
  const [b] = await tx.select({ id: bills.id }).from(bills).where(sql`${bills.customerId} = ${customerId} and ${bills.status} = 'open'`);
  return b!.id;
}

export async function addLine(
  tx: Tx,
  a: AuthCtx,
  line: { billId: string; rentalId?: string | null; kind: (typeof billLines.$inferInsert)['kind']; description: string; amount: number; reason?: string | null },
) {
  const [row] = await tx
    .insert(billLines)
    .values({ orgId: a.orgId, createdBy: a.userId, rentalId: line.rentalId ?? null, billId: line.billId, kind: line.kind, description: line.description, amount: line.amount, reason: line.reason ?? null })
    .returning();
  return row!;
}

export async function settingsOf(tx: Tx, orgId: string) {
  const [s] = await tx.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
  return s!;
}

/** เหตุการณ์ให้ worker ส่งออก (Marketplace / WhatsApp) · เขียนในธุรกรรมเดียวกับข้อมูลจริง */
export async function emit(tx: Tx, a: AuthCtx, type: string, payload: Record<string, unknown>) {
  await tx.insert(outboxEvents).values({ orgId: a.orgId, type, payload });
}

export function baht(minor: number): string {
  return `฿${(minor / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/**
 * ล็อกของรายชิ้น/ไซส์ด้วย advisory lock (ใช้ร่วมกันทุกเซิร์ฟเวอร์ · ปลดเองเมื่อจบธุรกรรม)
 * ลำดับเดียวกันทุกที่ กัน deadlock: (ล็อกแถวคำขอจองก่อน ถ้ามี) → ของรายชิ้นเรียงตาม id → ไซส์เรียงตาม id
 */
export async function lockAssets(tx: Tx, assetIds: Array<string | null | undefined>, variantIds: Array<string | null | undefined> = []) {
  const units = [...new Set(assetIds.filter((x): x is string => !!x))].sort();
  const sizes = [...new Set(variantIds.filter((x): x is string => !!x))].sort();
  for (const id of units) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`asset:${id}`}, 0))`);
  for (const id of sizes) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`variant:${id}`}, 0))`);
}

/** เลขใบเสร็จ RC-YYMM-NNNN · เดือนตามเขตเวลาของร้าน (ไม่ใช่ของเซิร์ฟเวอร์) */
export async function nextReceiptNo(tx: Tx, orgId: string): Promise<string> {
  const [org] = await tx.select({ tz: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  const r = (
    await tx.execute<{ n: string; ym: string }>(
      sql`select app.next_counter('receipt') as n, to_char(now() at time zone ${org?.tz ?? 'Asia/Bangkok'}::text, 'YYMM') as ym`,
    )
  ).rows[0]!;
  return `RC-${r.ym}-${String(r.n).padStart(4, '0')}`;
}

/** ยอดรวม · จ่ายแล้ว · คงค้าง · จำนวนรายการ ของบิล (อ่านหลังล็อกแถวบิลแล้ว จึงเห็นข้อมูลล่าสุด) */
export async function billTotals(tx: Tx, billId: string) {
  const r = (
    await tx.execute<{ total: string; paid: string; lines: string }>(sql`
      select (select coalesce(sum(amount), 0) from bill_lines where bill_id = ${billId}) as total,
             (select coalesce(sum(amount), 0) from payments where bill_id = ${billId}) as paid,
             (select count(*) from bill_lines where bill_id = ${billId}) as lines`)
  ).rows[0]!;
  const total = Number(r.total);
  const paid = Number(r.paid);
  return { total, paid, balance: total - paid, lines: Number(r.lines) };
}

/** ล็อกแถวบิล (กันสองเครื่องรับเงิน/ลดราคาพร้อมกัน) · คืนสถานะ */
export async function lockBill(tx: Tx, billId: string) {
  const [b] = await tx.select({ id: bills.id, status: bills.status, customerId: bills.customerId }).from(bills).where(eq(bills.id, billId)).for('update');
  return b;
}

/**
 * ปิดบิลเมื่อยอดคงค้างเป็น 0 พอดี (มีรายการอย่างน้อย 1 และยอดรวมไม่ติดลบ) · ออกเลขใบเสร็จ
 * ยอดติดลบ (จ่ายแล้วแต่ยกเลิกทีหลัง) = ค้างคืนเงินลูกค้า · บิลยังเปิดไว้ให้เห็น
 * ต้องล็อกแถวบิลก่อนเรียก
 */
export async function settleIfZero(tx: Tx, a: AuthCtx, billId: string, customerId: string): Promise<string | null> {
  const t = await billTotals(tx, billId);
  if (t.lines === 0 || t.total < 0 || t.balance !== 0) return null;
  const receiptNo = await nextReceiptNo(tx, a.orgId);
  await tx.update(bills).set({ status: 'paid', paidAt: new Date(), receiptNo }).where(eq(bills.id, billId));
  await emit(tx, a, 'bill.paid', { billId, customerId, receiptNo });
  return receiptNo;
}

const MAX_PAST_MS = 24 * 3_600_000;
const MAX_FUTURE_MS = 5 * 60_000;
const RISKY_SKEW_MS = 10 * 60_000;

/**
 * เวลาที่เครื่องส่งมา (ปล่อยเช่า/รับคืน) · ใช้ให้โหมดออฟไลน์บันทึกเวลาที่กดจริง
 * พนักงาน: ย้อนได้ไม่เกิน 24 ชม. · เจ้าของ: ย้อนได้ (ลงข้อมูลย้อนหลังจากกระดาษ) · อนาคตได้ไม่เกิน 5 นาที (นาฬิกาเครื่องคลาด)
 * ต่างจากเวลาเซิร์ฟเวอร์เกิน 10 นาที = รายการเสี่ยงในประวัติ
 */
export function clientTime(iso: string | undefined, a: Pick<AuthCtx, 'role'>): { at: Date; risky: boolean } {
  const now = Date.now();
  if (!iso) return { at: new Date(now), risky: false };
  const at = new Date(iso);
  const diff = at.getTime() - now;
  if (diff > MAX_FUTURE_MS || (a.role !== 'owner' && diff < -MAX_PAST_MS)) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'time_out_of_range');
  }
  return { at, risky: Math.abs(diff) > RISKY_SKEW_MS };
}
