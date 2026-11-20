import { Controller, Get, HttpStatus, Inject } from '@nestjs/common';
import type { Db } from '@rental/db';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { AppError } from './common/http.js';
import { DB, VALKEY } from './infra.js';

/** load balancer ใช้ /health (process ยังอยู่) และ /ready (พร้อมรับงาน: ต่อฐานข้อมูลและ Valkey ได้) */
@Controller()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  @Get('health')
  health() {
    return { ok: true };
  }

  @Get('ready')
  async ready() {
    const [db, valkey] = await Promise.allSettled([this.db.execute(sql`select 1`), this.valkey.ping()]);
    const status = { db: db.status === 'fulfilled', valkey: valkey.status === 'fulfilled' };
    if (!status.db || !status.valkey) throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'not_ready', status);
    return { ok: true, ...status };
  }
}
