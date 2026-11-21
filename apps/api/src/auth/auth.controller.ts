import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { orgs, orgSettings, users, withTenant, type Db } from '@rental/db';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CONFIG, type Config } from '../config.js';
import { AppError, parse } from '../common/http.js';
import { RateLimiter } from '../common/rate-limit.js';
import { DB } from '../infra.js';
import { AuthService, type LoginResult } from './auth.service.js';
import { Auth, DEVICE_COOKIE, SESSION_COOKIE, type AuthCtx } from './context.js';
import { newToken } from './crypto.js';
import { passwordProblems, passwordSchema } from './password-policy.js';
import { SessionGuard } from './session.guard.js';

const PENDING_COOKIE = 'rp';
/** ตั๋วรอใส่รหัส 6 หลัก (เจ้าของร้านเข้าจากเครื่องใหม่) */
const TOTP_COOKIE = 'rt';
const DEVICE_COOKIE_DAYS = 400;

const loginBody = z.object({
  identifier: z.string().trim().min(3).max(64),
  password: z.string().min(1).max(128),
  orgId: z.string().uuid().optional(),
  deviceName: z.string().trim().max(60).optional(),
});

const totpBody = z
  .object({
    code: z.string().trim().max(10).optional(),
    backupCode: z.string().trim().max(20).optional(),
  })
  .refine((v) => !!v.code !== !!v.backupCode, 'code_or_backup');

const signupBody = z.object({
  shopName: z.string().trim().min(2).max(80),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'slug_format'),
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
  password: passwordSchema(),
});

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly limiter: RateLimiter,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parse(loginBody, body);
    const ip = req.ip ?? 'unknown';
    await this.limiter.hit('login-ip', ip, 30, 900);
    await this.limiter.hit('login-id', input.identifier.toLowerCase(), 10, 900);

    let issuedSecret: string | undefined;
    const result = await this.auth.login(
      { ...input, deviceSecret: this.deviceSecret(req), userAgent: req.get('user-agent'), ip: req.ip ?? null },
      () => (issuedSecret = newToken()),
    );
    if (issuedSecret) this.setDeviceCookie(res, issuedSecret);
    return this.respond(result, res);
  }

  /** เครื่องที่รออนุมัติเรียกซ้ำทุกไม่กี่วินาที */
  @Get('pending')
  async pending(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token: unknown = req.cookies?.[PENDING_COOKIE];
    if (typeof token !== 'string') return { status: 'expired' };
    await this.limiter.hit('pending', req.ip ?? 'unknown', 120, 600);
    const result = await this.auth.pendingStatus(token, req.ip ?? null);
    if (result.status === 'expired') {
      res.clearCookie(PENDING_COOKIE, this.cookieBase());
      return result;
    }
    return this.respond(result, res);
  }

  /** เจ้าของร้านเครื่องใหม่: ใส่รหัส 6 หลักจากแอป (หรือรหัสสำรอง) */
  @Post('login/totp')
  @HttpCode(200)
  async loginTotp(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parse(totpBody, body);
    const token: unknown = req.cookies?.[TOTP_COOKIE];
    if (typeof token !== 'string') throw new AppError(401, 'totp_expired');
    await this.limiter.hit('login-totp', req.ip ?? 'unknown', 20, 900);
    const result = await this.auth.loginTotp(token, input, req.ip ?? null);
    if (result.status === 'expired') {
      res.clearCookie(TOTP_COOKIE, this.cookieBase());
      throw new AppError(401, 'totp_expired');
    }
    res.clearCookie(TOTP_COOKIE, this.cookieBase());
    return this.respond(result, res);
  }

  @Post('signup')
  @HttpCode(201)
  async signup(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parse(signupBody, body);
    await this.limiter.hit('signup-ip', req.ip ?? 'unknown', 5, 3600);
    const problems = passwordProblems(input.password, [input.username, input.phone, input.slug]);
    if (problems.length) throw new AppError(400, 'weak_password', { problems });
    const secret = this.deviceSecret(req) ?? newToken();
    this.setDeviceCookie(res, secret);
    const result = await this.auth.signup(input, secret, { ip: req.ip ?? null, userAgent: req.get('user-agent') });
    return this.respond(result, res);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(@Auth() a: AuthCtx, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(a.sessionId, a.userId, a.orgId);
    res.clearCookie(SESSION_COOKIE, this.cookieBase());
  }

  @Get('me')
  @UseGuards(SessionGuard)
  async me(@Auth() a: AuthCtx) {
    return withTenant(this.db, a, async (tx) => {
      const [user] = await tx
        .select({ id: users.id, username: users.username, displayName: users.displayName, phone: users.phone })
        .from(users)
        .where(eq(users.id, a.userId));
      const [org] = await tx
        .select({ id: orgs.id, name: orgs.name, slug: orgs.slug, timezone: orgs.timezone, currency: orgs.currency, locale: orgs.locale })
        .from(orgs)
        .where(eq(orgs.id, a.orgId));
      const [settings] = await tx.select().from(orgSettings).where(eq(orgSettings.orgId, a.orgId));
      return { user, org, role: a.role, deviceId: a.deviceId, customerModeRentalId: a.customerModeRentalId, settings };
    });
  }

  private respond(result: LoginResult, res: Response) {
    if (result.status === 'ok') {
      res.cookie(SESSION_COOKIE, result.sessionToken, { ...this.cookieBase(), expires: result.expiresAt });
      res.clearCookie(PENDING_COOKIE, this.cookieBase());
      return { status: 'ok', orgId: result.orgId, userId: result.userId, role: result.role };
    }
    if (result.status === 'device_pending') {
      res.cookie(PENDING_COOKIE, result.pendingToken, { ...this.cookieBase(), maxAge: result.expiresInSeconds * 1000 });
      res.status(202);
      return { status: 'device_pending', deviceId: result.deviceId, approvalCode: result.approvalCode, expiresInSeconds: result.expiresInSeconds };
    }
    if (result.status === 'totp_required') {
      res.cookie(TOTP_COOKIE, result.pendingToken, { ...this.cookieBase(), maxAge: result.expiresInSeconds * 1000 });
      res.status(202);
      return { status: 'totp_required', expiresInSeconds: result.expiresInSeconds };
    }
    return result;
  }

  private deviceSecret(req: Request): string | undefined {
    const v: unknown = req.cookies?.[DEVICE_COOKIE];
    return typeof v === 'string' && v.length >= 20 ? v : undefined;
  }

  private setDeviceCookie(res: Response, secret: string) {
    res.cookie(DEVICE_COOKIE, secret, { ...this.cookieBase(), maxAge: DEVICE_COOKIE_DAYS * 86_400_000 });
  }

  private cookieBase() {
    return { httpOnly: true, sameSite: 'lax' as const, secure: this.config.COOKIE_SECURE, path: '/' };
  }
}
