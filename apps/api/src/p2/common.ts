import { orgs, type Tx } from '@rental/db';
import { eq, sql } from 'drizzle-orm';
import { HttpStatus } from '@nestjs/common';
import { AppError } from '../common/http.js';

/** เขตเวลาของร้าน (รายงาน/ประวัติใช้ "วัน" ตามเวลาท้องถิ่นของร้าน ไม่ใช่ของเซิร์ฟเวอร์) */
export async function orgTimezone(tx: Tx, orgId: string): Promise<string> {
  const [o] = await tx.select({ tz: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  return o?.tz ?? 'Asia/Bangkok';
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** ช่วงวันที่ (รวมทั้งสองวัน) → [start, end) เป็น timestamptz ตามเขตเวลาร้าน · ใช้ Postgres คำนวณเพื่อให้ถูกต้องเรื่องเวลา */
export async function dayRange(tx: Tx, tz: string, from: string, to: string): Promise<{ start: Date; end: Date; from: string; to: string }> {
  if (!DATE.test(from) || !DATE.test(to)) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_date_range');
  if (from > to) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_date_range');
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days > 400) throw new AppError(HttpStatus.BAD_REQUEST, 'range_too_long');
  const r = await tx.execute<{ start: string; end: string }>(
    sql`select (${from}::date::timestamp at time zone ${tz}) as start, ((${to}::date + 1)::timestamp at time zone ${tz}) as end`,
  );
  const row = r.rows[0]!;
  return { start: new Date(row.start), end: new Date(row.end), from, to };
}

/** วันนี้ตามเขตเวลาร้าน (YYYY-MM-DD) */
export async function localToday(tx: Tx, tz: string): Promise<string> {
  const r = await tx.execute<{ d: string }>(sql`select (now() at time zone ${tz})::date::text as d`);
  return r.rows[0]!.d;
}

/** ช่อง CSV: ใส่ "" รอบค่าที่มี , " หรือขึ้นบรรทัด · กันสูตร Excel (ค่าที่ขึ้นต้น = + - @) */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csv(rows: unknown[][]): string {
  // BOM ให้ Excel อ่านภาษาไทยเป็น UTF-8
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
