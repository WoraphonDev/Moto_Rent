import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { devices, memberships, orgs, sessions, withTenant, type Db, type Tx } from '@rental/db';
import { and, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { CONFIG, type Config } from '../config.js';
import { audit } from '../common/audit.js';
import { AppError, pgError } from '../common/http.js';
import { DB, VALKEY } from '../infra.js';
import type { Role } from './context.js';
import { approvalCode, hashPassword, newToken, tokenHash, verifyPassword } from './crypto.js';

export interface OrgChoice {
  orgId: string;
  name: string;
  role: Role;
}

export type LoginResult =
  | { status: 'ok'; sessionToken: string; expiresAt: Date; orgId: string; userId: string; role: Role }
  | { status: 'choose_org'; orgs: OrgChoice[] }
  | { status: 'device_pending'; deviceId: string; approvalCode: string; pendingToken: string; expiresInSeconds: number };

export interface LoginInput {
  identifier: string;
  password: string;
  orgId?: string;
  deviceSecret?: string;
  deviceName?: string;
  userAgent?: string;
  ip: string | null;
}

const PENDING_TTL_SECONDS = 600;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /** ตรวจรหัส → เลือกร้าน → ตรวจเครื่อง → ออก session */
  async login(input: LoginInput, newDeviceSecret: () => string): Promise<LoginResult> {
    const found = await this.db.execute<{ user_id: string; password_hash: string | null; locked_until: Date | null; disabled: boolean }>(
      sql`select * from auth.find_login(${input.identifier.trim()})`,
    );
    const u = found.rows[0];
    // ตรวจรหัสทุกครั้ง (รวมตอนบัญชีถูกพัก) ให้เวลาตอบเท่ากัน และไม่บอกว่าบัญชีนี้มีอยู่/ถูกล็อก
    const ok = await verifyPassword(u?.password_hash ?? null, input.password);
    if (!u || !ok || u.disabled) {
      if (u && !u.disabled) {
        await this.db.execute(
          sql`select * from auth.record_login_failure(${u.user_id}, ${this.config.LOGIN_MAX_ATTEMPTS}, ${this.config.LOGIN_LOCK_MINUTES})`,
        );
      }
      throw new AppError(HttpStatus.UNAUTHORIZED, 'invalid_credentials');
    }
    const locked = !!u.locked_until && new Date(u.locked_until) > new Date();
    if (locked) {
      // คนนอกใส่รหัสผิดรัวๆ เพื่อล็อกเจ้าของร้านได้ · จึงยอมให้เข้าจากเครื่องที่เคยอนุมัติแล้วของบัญชีนี้ตามปกติ
      // เครื่องใหม่ต้องรอให้พ้นช่วงพักก่อน (ตอบเหมือนรหัสผิด)
      const trusted = input.deviceSecret ? await this.isTrustedDevice(u.user_id, input.deviceSecret) : false;
      if (!trusted) throw new AppError(HttpStatus.UNAUTHORIZED, 'invalid_credentials');
    }
    await this.db.execute(sql`select auth.record_login_success(${u.user_id})`);

    const choices = await this.orgChoices(u.user_id);
    if (choices.length === 0) throw new AppError(HttpStatus.FORBIDDEN, 'no_active_membership');
    const chosen = input.orgId ? choices.find((c) => c.orgId === input.orgId) : choices.length === 1 ? choices[0] : undefined;
    if (!chosen) {
      if (input.orgId) throw new AppError(HttpStatus.FORBIDDEN, 'not_a_member');
      return { status: 'choose_org', orgs: choices };
    }

    const userId = u.user_id;
    const orgId = chosen.orgId;
    const role = chosen.role;
    const secret = input.deviceSecret ?? newDeviceSecret();
    const device = await withTenant(this.db, { userId, orgId }, (tx) =>
      this.resolveDevice(tx, { userId, orgId, role, ip: input.ip }, secret, input.deviceName, input.userAgent),
    );

    if (device.status === 'revoked') throw new AppError(HttpStatus.FORBIDDEN, 'device_revoked');
    if (device.status === 'pending') {
      const pendingToken = newToken();
      await this.valkey.set(
        `pending:${tokenHash(pendingToken)}`,
        JSON.stringify({ userId, orgId, deviceId: device.id }),
        'EX',
        PENDING_TTL_SECONDS,
      );
      return { status: 'device_pending', deviceId: device.id, approvalCode: device.approvalCode, pendingToken, expiresInSeconds: PENDING_TTL_SECONDS };
    }
    return this.startSession(userId, orgId, role, device.id, input.ip);
  }

  /** เครื่องที่รออนุมัติถามซ้ำเป็นระยะ · อนุมัติแล้วเข้าระบบให้เองโดยไม่ต้องใส่รหัสอีก */
  async pendingStatus(pendingToken: string, ip: string | null): Promise<LoginResult | { status: 'expired' }> {
    const key = `pending:${tokenHash(pendingToken)}`;
    const raw = await this.valkey.get(key);
    if (!raw) return { status: 'expired' };
    const p = JSON.parse(raw) as { userId: string; orgId: string; deviceId: string };
    const state = await withTenant(this.db, { userId: p.userId, orgId: p.orgId }, async (tx) => {
      const [d] = await tx
        .select({ status: devices.status, approvalCode: devices.approvalCode })
        .from(devices)
        .where(eq(devices.id, p.deviceId));
      const [m] = await tx
        .select({ role: memberships.role, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.orgId, p.orgId), eq(memberships.userId, p.userId)));
      return { device: d, member: m };
    });
    if (!state.device || !state.member || state.member.status !== 'active' || state.device.status === 'revoked') {
      await this.valkey.del(key);
      throw new AppError(HttpStatus.FORBIDDEN, 'device_revoked');
    }
    if (state.device.status === 'pending') {
      const ttl = await this.valkey.ttl(key);
      return { status: 'device_pending', deviceId: p.deviceId, approvalCode: state.device.approvalCode, pendingToken, expiresInSeconds: ttl };
    }
    // ใช้ตั๋วได้ครั้งเดียว: ลบก่อนออก session กันสองแท็บได้ session ซ้ำ
    if ((await this.valkey.del(key)) === 0) return { status: 'expired' };
    return this.startSession(p.userId, p.orgId, state.member.role as Role, p.deviceId, ip);
  }

  /** สมัครร้านใหม่: ร้าน + สาขาแรก + เจ้าของ + เครื่องนี้ (อนุมัติแล้ว) + session */
  async signup(
    input: { slug: string; shopName: string; username: string; displayName: string; phone?: string; password: string },
    deviceSecret: string,
    meta: { ip: string | null; userAgent?: string },
  ) {
    const passwordHash = await hashPassword(input.password);
    let ids: { user_id: string; org_id: string };
    try {
      const r = await this.db.execute<{ user_id: string; org_id: string }>(
        sql`select * from auth.create_org(${input.slug}, ${input.shopName}, ${input.username}, ${input.displayName}, ${input.phone ?? null}, ${passwordHash})`,
      );
      ids = r.rows[0]!;
    } catch (e) {
      const pe = pgError(e);
      if (pe.code === '23505') {
        const field = pe.message?.includes('orgs_slug') ? 'slug_taken' : pe.message?.includes('phone') ? 'phone_taken' : 'username_taken';
        throw new AppError(HttpStatus.CONFLICT, field);
      }
      if (pe.code === '23514') throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_input');
      throw e;
    }
    const ctx = { userId: ids.user_id, orgId: ids.org_id, role: 'owner' as const, ip: meta.ip };
    const device = await withTenant(this.db, ctx, (tx) => this.resolveDevice(tx, ctx, deviceSecret, 'เครื่องเจ้าของ', meta.userAgent));
    return this.startSession(ids.user_id, ids.org_id, 'owner', device.id, meta.ip);
  }

  async logout(sessionId: string, userId: string, orgId: string) {
    await withTenant(this.db, { userId, orgId }, (tx) =>
      tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId)),
    );
  }

  /** เครื่องนี้เคยได้รับอนุมัติในร้านใดร้านหนึ่งของผู้ใช้ และเป็นเครื่องที่ผู้ใช้คนนี้ขอเอง */
  private async isTrustedDevice(userId: string, secret: string): Promise<boolean> {
    const hash = tokenHash(secret);
    for (const c of await this.orgChoices(userId)) {
      const found = await withTenant(this.db, { userId, orgId: c.orgId }, (tx) =>
        tx
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.orgId, c.orgId), eq(devices.secretHash, hash), eq(devices.status, 'approved'), eq(devices.requestedBy, userId))),
      );
      if (found.length) return true;
    }
    return false;
  }

  private async orgChoices(userId: string): Promise<OrgChoice[]> {
    return withTenant(this.db, { userId, orgId: null }, (tx) =>
      tx
        .select({ orgId: memberships.orgId, name: orgs.name, role: memberships.role })
        .from(memberships)
        .innerJoin(orgs, eq(orgs.id, memberships.orgId))
        .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active'), eq(orgs.status, 'active')))
        .orderBy(orgs.name),
    ) as Promise<OrgChoice[]>;
  }

  /**
   * หาเครื่องจาก secret · ไม่เคยเห็น = ขออนุมัติใหม่
   * เจ้าของร้านอนุมัติเครื่องตัวเองได้ทันที (ร้านเล็กมีเจ้าของคนเดียว ไม่มีใครอนุมัติแทน) แต่บันทึกเป็นรายการเสี่ยงให้เห็นในประวัติ
   * TODO(เฟส 0.2): เจ้าของต้องยืนยัน 2 ชั้นก่อนอนุมัติเครื่องตัวเอง
   */
  private async resolveDevice(
    tx: Tx,
    ctx: { userId: string; orgId: string; role: Role; ip: string | null },
    secret: string,
    name: string | undefined,
    userAgent: string | undefined,
  ) {
    const secretHash = tokenHash(secret);
    const [existing] = await tx
      .select({ id: devices.id, status: devices.status, approvalCode: devices.approvalCode })
      .from(devices)
      .where(and(eq(devices.orgId, ctx.orgId), eq(devices.secretHash, secretHash)));
    if (existing) return existing;

    const code = approvalCode();
    const [created] = await tx
      .insert(devices)
      .values({
        orgId: ctx.orgId,
        secretHash,
        name: (name ?? '').trim().slice(0, 60) || 'เครื่องใหม่',
        userAgent: userAgent?.slice(0, 300) ?? null,
        approvalCode: code,
        requestedBy: ctx.userId,
      })
      .returning({ id: devices.id, status: devices.status, approvalCode: devices.approvalCode });
    const auth = { ...ctx, deviceId: created!.id };
    if (ctx.role === 'owner') {
      await tx
        .update(devices)
        .set({ status: 'approved', approvedBy: ctx.userId, approvedAt: new Date() })
        .where(eq(devices.id, created!.id));
      await audit(tx, auth, { action: 'device.owner_self_approved', entityType: 'device', entityId: created!.id, risk: 'risky' });
      return { ...created!, status: 'approved' };
    }
    await audit(tx, auth, { action: 'device.requested', entityType: 'device', entityId: created!.id });
    return created!;
  }

  private async startSession(userId: string, orgId: string, role: Role, deviceId: string, ip: string | null): Promise<LoginResult> {
    const token = newToken();
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL_HOURS * 3_600_000);
    await withTenant(this.db, { userId, orgId }, async (tx) => {
      const [s] = await tx
        .insert(sessions)
        .values({ tokenHash: tokenHash(token), userId, orgId, deviceId, ip, expiresAt })
        .returning({ id: sessions.id });
      await audit(tx, { userId, orgId, deviceId, ip }, { action: 'auth.login', entityType: 'session', entityId: s!.id });
    });
    return { status: 'ok', sessionToken: token, expiresAt, orgId, userId, role };
  }
}
