import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/http.js';
import { RateLimiter } from '../common/rate-limit.js';
import { Auth, type AuthCtx } from './context.js';
import { SessionGuard } from './session.guard.js';
import { TotpService } from './totp.service.js';

const codeBody = z.object({ code: z.string().trim().max(10) });
const verifyBody = z
  .object({ code: z.string().trim().max(10).optional(), backupCode: z.string().trim().max(20).optional() })
  .refine((v) => !!v.code !== !!v.backupCode, 'code_or_backup');
const disableBody = z.object({
  password: z.string().min(1).max(128),
  code: z.string().trim().max(10).optional(),
  backupCode: z.string().trim().max(20).optional(),
});

/** ยืนยันตัวตน 2 ชั้นของผู้ใช้ที่เข้าระบบอยู่ (mock 7.W1) */
@Controller('v1/auth/2fa')
@UseGuards(SessionGuard)
export class TotpController {
  constructor(
    private readonly totp: TotpService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  status(@Auth() a: AuthCtx) {
    return this.totp.status(a);
  }

  @Post('setup')
  @HttpCode(200)
  async setup(@Auth() a: AuthCtx) {
    await this.limiter.hit('totp-setup', a.userId, 10, 3600);
    return this.totp.begin(a);
  }

  @Post('enable')
  @HttpCode(200)
  async enable(@Auth() a: AuthCtx, @Body() body: unknown) {
    const input = parse(codeBody, body);
    await this.limiter.hit('totp-verify', a.userId, 20, 900);
    return this.totp.enable(a, input.code);
  }

  @Post('verify')
  @HttpCode(204)
  async verify(@Auth() a: AuthCtx, @Body() body: unknown) {
    const input = parse(verifyBody, body);
    await this.limiter.hit('totp-verify', a.userId, 20, 900);
    await this.totp.verify(a, input);
  }

  @Post('backup-codes')
  @HttpCode(200)
  backupCodes(@Auth() a: AuthCtx) {
    return this.totp.regenerateBackup(a);
  }

  @Post('disable')
  @HttpCode(204)
  async disable(@Auth() a: AuthCtx, @Body() body: unknown) {
    const input = parse(disableBody, body);
    await this.limiter.hit('totp-verify', a.userId, 20, 900);
    await this.totp.disable(a, input.password, input);
  }
}
