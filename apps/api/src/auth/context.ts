import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export type Role = 'owner' | 'manager' | 'staff';

/** ตัวตนของคำขอ หลังผ่าน SessionGuard */
export interface AuthCtx {
  sessionId: string;
  userId: string;
  orgId: string;
  deviceId: string | null;
  role: Role;
  ip: string | null;
  /** เครื่องอยู่ในโหมดลูกค้า (ยื่นให้ลูกค้าเซ็น) · ใช้ได้เฉพาะสัญญานี้จนพนักงานใส่รหัสผ่าน */
  customerModeRentalId: string | null;
}

export type AuthedRequest = Request & { auth?: AuthCtx };

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthCtx => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new Error('Auth used on a route without SessionGuard');
  return req.auth;
});

export const ROLES_KEY = 'roles';
/** บทบาทที่เรียก route ได้ · ไม่ใส่ = สมาชิกทุกบทบาท */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const SESSION_COOKIE = 'rs';
export const DEVICE_COOKIE = 'rd';
