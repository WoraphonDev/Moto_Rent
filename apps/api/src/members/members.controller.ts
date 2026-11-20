import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { devices, invitations, memberships, sessions, users, withTenant, type Db } from '@rental/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { CONFIG, type Config } from '../config.js';
import { audit } from '../common/audit.js';
import { AppError, parse, pgError } from '../common/http.js';
import { RateLimiter } from '../common/rate-limit.js';
import { DB } from '../infra.js';
import { Auth, Roles, type AuthCtx } from '../auth/context.js';
import { hashPassword, newToken, tokenHash } from '../auth/crypto.js';
import { passwordProblems, passwordSchema } from '../auth/password-policy.js';
import { SessionGuard } from '../auth/session.guard.js';

const INVITE_TTL_MS = 24 * 3_600_000;

const inviteBody = z.object({
  username: z
    .string()
    .trim()
    .regex(/^(?=.*[a-zA-Z])[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/, 'username_format'),
  displayName: z.string().trim().min(1).max(60),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{8,15}$/, 'phone_format')
    .optional(),
  role: z.enum(['manager', 'staff']),
});
const acceptBody = z.object({ password: passwordSchema() });
const approveBody = z.object({ code: z.string().trim().toUpperCase().length(4) });

/** บัญชีพนักงาน ลิงก์เชิญ และเครื่องที่อนุญาต (หน้า 2.05 / 2.W6 ใน mock) */
@Controller('v1')
export class MembersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    private readonly limiter: RateLimiter,
  ) {}

  // ---------- ลิงก์เชิญ ----------

  @Post('invitations')
  @UseGuards(SessionGuard)
  @Roles('owner')
  async invite(@Auth() a: AuthCtx, @Body() body: unknown) {
    const input = parse(inviteBody, body);
    await this.limiter.hit('invite-create', a.userId, 30, 3600);
    const taken = await this.db.execute(sql`select 1 from auth.find_login(${input.username})`);
    if (taken.rows.length) throw new AppError(HttpStatus.CONFLICT, 'username_taken');
    return this.createLink(a, { kind: 'invite', ...input, userId: null });
  }

  @Post('members/:userId/reset-link')
  @UseGuards(SessionGuard)
  @Roles('owner')
  async resetLink(@Auth() a: AuthCtx, @Param('userId', ParseUUIDPipe) userId: string) {
    const member = await withTenant(this.db, a, async (tx) => {
      const [m] = await tx
        .select({ username: users.username, displayName: users.displayName, phone: users.phone, role: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.orgId, a.orgId), eq(memberships.userId, userId), eq(memberships.status, 'active')));
      return m;
    });
    if (!member) throw new AppError(HttpStatus.NOT_FOUND, 'member_not_found');
    return this.createLink(a, {
      kind: 'reset',
      userId,
      username: member.username,
      displayName: member.displayName,
      phone: member.phone ?? undefined,
      role: member.role as 'owner' | 'manager' | 'staff',
    });
  }

  /** หน้าตั้งรหัสเปิดลิงก์ (ยังไม่เข้าระบบ) */
  @Get('invitations/:token')
  async lookup(@Param('token') token: string, @Req() req: Request) {
    await this.limiter.hit('invite-lookup', req.ip ?? 'unknown', 30, 600);
    const r = await this.db.execute<Record<string, unknown>>(sql`select * from auth.invitation_lookup(${tokenHash(token)})`);
    const inv = r.rows[0];
    if (!inv) throw new AppError(HttpStatus.NOT_FOUND, 'invitation_invalid');
    return {
      kind: inv.kind,
      orgName: inv.org_name,
      username: inv.username,
      displayName: inv.display_name,
      role: inv.role,
      // raw SQL คืนเวลาเป็นข้อความรูปแบบ Postgres ("2026-11-21 19:17:35+00") ซึ่ง Safari อ่านไม่ได้ · ส่งเป็น ISO เสมอ
      expiresAt: new Date(String(inv.expires_at)).toISOString(),
    };
  }

  @Post('invitations/:token/accept')
  @HttpCode(200)
  async accept(@Param('token') token: string, @Body() body: unknown, @Req() req: Request) {
    await this.limiter.hit('invite-accept', req.ip ?? 'unknown', 10, 600);
    const { password } = parse(acceptBody, body);
    const r = await this.db.execute<{ username: string }>(sql`select * from auth.invitation_lookup(${tokenHash(token)})`);
    const inv = r.rows[0];
    if (!inv) throw new AppError(HttpStatus.NOT_FOUND, 'invitation_invalid');
    const problems = passwordProblems(password, [inv.username]);
    if (problems.length) throw new AppError(HttpStatus.BAD_REQUEST, 'weak_password', { problems });
    try {
      await this.db.execute(sql`select * from auth.accept_invitation(${tokenHash(token)}, ${await hashPassword(password)})`);
    } catch (e) {
      const pe = pgError(e);
      if (pe.message?.includes('invitation_invalid')) throw new AppError(HttpStatus.NOT_FOUND, 'invitation_invalid');
      if (pe.code === '23505') throw new AppError(HttpStatus.CONFLICT, 'username_taken');
      throw e;
    }
    // ขั้นต่อไปคือเข้าระบบบนเครื่องนี้ ซึ่งจะขออนุมัติเครื่องจากเจ้าของ
    return { status: 'ok', username: inv.username };
  }

  @Post('invitations/:id/revoke')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  @Roles('owner')
  async revokeInvite(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string) {
    await withTenant(this.db, a, async (tx) => {
      const r = await tx
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(and(eq(invitations.id, id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
        .returning({ id: invitations.id });
      if (!r.length) throw new AppError(HttpStatus.NOT_FOUND, 'invitation_invalid');
      await audit(tx, a, { action: 'invitation.revoked', entityType: 'invitation', entityId: id });
    });
  }

  // ---------- สมาชิก ----------

  @Get('members')
  @UseGuards(SessionGuard)
  async members(@Auth() a: AuthCtx) {
    return withTenant(this.db, a, async (tx) => {
      const rows = await tx
        .select({
          userId: users.id,
          username: users.username,
          displayName: users.displayName,
          role: memberships.role,
          status: memberships.status,
          closedAt: memberships.closedAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.orgId, a.orgId))
        .orderBy(memberships.createdAt);
      const pending =
        a.role === 'owner'
          ? await tx
              .select({ id: invitations.id, username: invitations.username, displayName: invitations.displayName, role: invitations.role, kind: invitations.kind, expiresAt: invitations.expiresAt })
              .from(invitations)
              .where(and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt), sql`${invitations.expiresAt} > now()`))
              .orderBy(desc(invitations.createdAt))
          : [];
      return { members: rows, pendingInvitations: pending };
    });
  }

  @Post('members/:userId/close')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  @Roles('owner')
  async close(@Auth() a: AuthCtx, @Param('userId', ParseUUIDPipe) userId: string) {
    if (userId === a.userId) throw new AppError(HttpStatus.BAD_REQUEST, 'cannot_close_self');
    await withTenant(this.db, a, async (tx) => {
      const r = await tx
        .update(memberships)
        .set({ status: 'closed', closedAt: new Date() })
        .where(and(eq(memberships.orgId, a.orgId), eq(memberships.userId, userId), eq(memberships.status, 'active')))
        .returning({ userId: memberships.userId });
      if (!r.length) throw new AppError(HttpStatus.NOT_FOUND, 'member_not_found');
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.orgId, a.orgId), eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      await audit(tx, a, { action: 'member.closed', entityType: 'user', entityId: userId });
    });
  }

  /** ออกจากทุกเครื่อง: เจ้าของทำให้ใครก็ได้ · คนอื่นทำได้เฉพาะของตัวเอง */
  @Post('members/:userId/sign-out-everywhere')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async signOutEverywhere(@Auth() a: AuthCtx, @Param('userId', ParseUUIDPipe) userId: string) {
    if (a.role !== 'owner' && userId !== a.userId) throw new AppError(HttpStatus.FORBIDDEN, 'forbidden');
    await withTenant(this.db, a, async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.orgId, a.orgId), eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      await audit(tx, a, { action: 'member.signed_out_everywhere', entityType: 'user', entityId: userId });
    });
  }

  // ---------- เครื่องที่อนุญาต ----------

  @Get('devices')
  @UseGuards(SessionGuard)
  @Roles('owner', 'manager')
  async devices(@Auth() a: AuthCtx) {
    return withTenant(this.db, a, (tx) =>
      tx
        .select({
          id: devices.id,
          name: devices.name,
          status: devices.status,
          requestedBy: users.displayName,
          createdAt: devices.createdAt,
          approvedAt: devices.approvedAt,
          lastSeenAt: devices.lastSeenAt,
        })
        .from(devices)
        .innerJoin(users, eq(users.id, devices.requestedBy))
        .orderBy(desc(devices.createdAt)),
    );
  }

  /** เจ้าของต้องพิมพ์รหัส 4 ตัวที่เห็นบนเครื่องที่ขอ กันกดอนุมัติผิดเครื่อง */
  @Post('devices/:id/approve')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  @Roles('owner')
  async approve(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { code } = parse(approveBody, body);
    await withTenant(this.db, a, async (tx) => {
      const [d] = await tx.select({ status: devices.status, code: devices.approvalCode }).from(devices).where(eq(devices.id, id));
      if (!d || d.status !== 'pending') throw new AppError(HttpStatus.NOT_FOUND, 'device_not_pending');
      if (d.code !== code) throw new AppError(HttpStatus.BAD_REQUEST, 'approval_code_mismatch');
      await tx.update(devices).set({ status: 'approved', approvedBy: a.userId, approvedAt: new Date() }).where(eq(devices.id, id));
      await audit(tx, a, { action: 'device.approved', entityType: 'device', entityId: id });
    });
  }

  @Post('devices/:id/revoke')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  @Roles('owner')
  async revoke(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string) {
    await withTenant(this.db, a, async (tx) => {
      const r = await tx
        .update(devices)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(and(eq(devices.id, id), sql`${devices.status} <> 'revoked'`))
        .returning({ id: devices.id });
      if (!r.length) throw new AppError(HttpStatus.NOT_FOUND, 'device_not_found');
      await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.deviceId, id), isNull(sessions.revokedAt)));
      await audit(tx, a, { action: 'device.revoked', entityType: 'device', entityId: id, risk: 'risky' });
    });
  }

  private async createLink(
    a: AuthCtx,
    input: { kind: 'invite' | 'reset'; userId: string | null; username: string; displayName: string; phone?: string; role: 'owner' | 'manager' | 'staff' },
  ) {
    const token = newToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const id = await withTenant(this.db, a, async (tx) => {
      // ลิงก์เก่าของคนเดียวกันที่ยังไม่ได้ใช้ ถูกยกเลิกเมื่อออกลิงก์ใหม่
      await tx
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(and(sql`lower(${invitations.username}) = lower(${input.username})`, isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
      const [row] = await tx
        .insert(invitations)
        .values({
          orgId: a.orgId,
          tokenHash: tokenHash(token),
          kind: input.kind,
          userId: input.userId,
          username: input.username,
          displayName: input.displayName,
          phone: input.phone ?? null,
          role: input.role,
          invitedBy: a.userId,
          expiresAt,
        })
        .returning({ id: invitations.id });
      await audit(tx, a, {
        action: input.kind === 'reset' ? 'member.reset_link_created' : 'invitation.created',
        entityType: 'invitation',
        entityId: row!.id,
        after: { username: input.username, role: input.role },
      });
      return row!.id;
    }).catch((e) => {
      if (pgError(e).code === '23505') throw new AppError(HttpStatus.CONFLICT, 'username_taken');
      throw e;
    });
    // token กลับไปครั้งเดียวตอนสร้าง · ฐานข้อมูลเก็บแค่ hash จึงขอดูซ้ำไม่ได้
    return { invitationId: id, url: `${this.config.WEB_ORIGIN}/invite/${token}`, expiresAt };
  }
}
