import { HttpStatus, Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Db } from '@rental/db';
import { sql } from 'drizzle-orm';
import { CONFIG, type Config } from '../config.js';
import { AppError } from '../common/http.js';
import { DB } from '../infra.js';
import { ROLES_KEY, SESSION_COOKIE, type AuthedRequest, type Role } from './context.js';
import { tokenHash } from './crypto.js';

/** ตรวจ session ทุกคำขอจากฐานข้อมูล (ไม่ใช้ JWT) จึงตัดสิทธิ์เครื่อง/ปิดบัญชีแล้วมีผลทันที */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length < 20) throw new AppError(HttpStatus.UNAUTHORIZED, 'unauthenticated');

    const r = await this.db.execute<{ session_id: string; user_id: string; org_id: string; device_id: string | null; role: Role; customer_mode_rental_id: string | null }>(
      sql`select * from auth.session_lookup(${tokenHash(token)}, ${this.config.SESSION_IDLE_MINUTES})`,
    );
    const s = r.rows[0];
    if (!s) throw new AppError(HttpStatus.UNAUTHORIZED, 'unauthenticated');

    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (allowed && !allowed.includes(s.role)) throw new AppError(HttpStatus.FORBIDDEN, 'forbidden');

    if (s.customer_mode_rental_id && !customerModeAllows(req.method, req.path, req.query, s.customer_mode_rental_id)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'customer_mode');
    }

    req.auth = {
      sessionId: s.session_id,
      userId: s.user_id,
      orgId: s.org_id,
      deviceId: s.device_id,
      role: s.role,
      ip: req.ip ?? null,
      customerModeRentalId: s.customer_mode_rental_id,
    };
    return true;
  }
}

/**
 * โหมดลูกค้า: ลูกค้าถือเครื่องของร้านอยู่ · เรียกได้เฉพาะสิ่งที่หน้าเซ็นสัญญาใช้กับสัญญาเดียว
 * (เดิมกันแค่ปุ่มย้อนกลับในเบราว์เซอร์ · ลูกค้าพิมพ์ URL อื่นแล้วเห็นข้อมูลลูกค้าคนอื่นได้)
 * ไฟล์ /v1/media/:id/content ผ่านได้ แต่ controller ตรวจซ้ำว่าเป็นไฟล์ของสัญญานี้
 */
export function customerModeAllows(method: string, path: string, query: Record<string, unknown>, rentalId: string): boolean {
  const p = path.replace(/\/+$/, '');
  if (method === 'GET' && p === `/v1/rentals/${rentalId}`) return true;
  if (method === 'GET' && p === '/v1/auth/me') return true;
  if (method === 'GET' && p === '/v1/media' && query.rentalId === rentalId && !query.customerId) return true;
  if (method === 'GET' && /^\/v1\/media\/[0-9a-f-]{36}\/content$/.test(p)) return true;
  // เปิดหน้าเซ็นซ้ำ/รีโหลดหน้า = เข้าโหมดเดิมซ้ำกับสัญญาเดียวกัน (สัญญาอื่นไม่ได้)
  if (method === 'POST' && (p === `/v1/rentals/${rentalId}/customer-mode` || p === `/v1/rentals/${rentalId}/sign` || p === '/v1/auth/confirm-staff' || p === '/v1/auth/logout')) return true;
  return false;
}
