import { Controller, Get, HttpStatus, Inject, Query, Res, UseGuards } from '@nestjs/common';
import { auditLog, devices, users, withTenant, type Db, type Tx } from '@rental/db';
import { and, desc, eq, gte, like, lt } from 'drizzle-orm';
import type { Response } from 'express';
import { AppError } from '../common/http.js';
import { DB } from '../infra.js';
import { Auth, Roles, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';
import { csv, dayRange, orgTimezone } from './common.js';

const PAGE = 50;
const CSV_MAX = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Filters {
  from?: string;
  to?: string;
  actor?: string;
  action?: string;
  risk?: string;
}

/** ประวัติการใช้งาน (mock 2.04 / 2.W5) · อ่านได้เฉพาะเจ้าของ/ผู้จัดการ (RLS บังคับซ้ำ) */
@Controller('v1')
@UseGuards(SessionGuard)
@Roles('owner', 'manager')
export class AuditController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('audit')
  async list(@Auth() a: AuthCtx, @Query() q: Filters & { cursor?: string }) {
    const cursor = q.cursor ? Number(q.cursor) : null;
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor <= 0)) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_input');
    return withTenant(this.db, a, async (tx) => {
      const where = await this.where(tx, a, q);
      const rows = await this.query(tx, cursor === null ? where : and(where, lt(auditLog.id, cursor)), PAGE + 1);
      const more = rows.length > PAGE;
      const page = more ? rows.slice(0, PAGE) : rows;
      // รายชื่อคนที่เคยทำรายการ (ใช้ทำตัวกรอง) · RLS ให้เห็นเฉพาะคนในร้าน
      const actors = await tx
        .selectDistinct({ id: users.id, displayName: users.displayName })
        .from(auditLog)
        .innerJoin(users, eq(users.id, auditLog.actorUserId))
        .orderBy(users.displayName);
      return { items: page, nextCursor: more ? String(page[page.length - 1]!.id) : null, actors };
    });
  }

  @Get('audit.csv')
  async csv(@Auth() a: AuthCtx, @Query() q: Filters, @Res() res: Response) {
    const rows = await withTenant(this.db, a, async (tx) => this.query(tx, await this.where(tx, a, q), CSV_MAX));
    const body = csv([
      ['id', 'time', 'actor', 'device', 'action', 'entity_type', 'entity_id', 'risk', 'reason', 'before', 'after', 'ip'],
      ...rows.map((r) => [r.id, r.createdAt, r.actorName ?? 'ระบบ', r.deviceName, r.action, r.entityType, r.entityId, r.risk, r.reason, r.before, r.after, r.ip]),
    ]);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('cache-control', 'no-store');
    res.send(body);
  }

  private async where(tx: Tx, a: AuthCtx, q: Filters) {
    const conds = [];
    if (q.from || q.to) {
      const tz = await orgTimezone(tx, a.orgId);
      const r = await dayRange(tx, tz, q.from ?? q.to!, q.to ?? q.from!);
      conds.push(gte(auditLog.createdAt, r.start), lt(auditLog.createdAt, r.end));
    }
    if (q.actor) {
      if (!UUID.test(q.actor)) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_input');
      conds.push(eq(auditLog.actorUserId, q.actor));
    }
    if (q.action) {
      // "rental" หรือ "rental.*" = ทุกเหตุการณ์ของหมวดนั้น · มีจุด = ตรงตัว
      const action = q.action.trim().slice(0, 60);
      if (!/^[a-z_]+(\.[a-z_*]+)?$/.test(action)) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_input');
      const prefix = action.endsWith('.*') ? action.slice(0, -1) : action.includes('.') ? null : `${action}.`;
      conds.push(prefix ? like(auditLog.action, `${prefix}%`) : eq(auditLog.action, action));
    }
    if (q.risk === 'risky') conds.push(eq(auditLog.risk, 'risky'));
    return conds.length ? and(...conds) : undefined;
  }

  private query(tx: Tx, where: ReturnType<typeof and>, limit: number) {
    return tx
      .select({
        id: auditLog.id,
        createdAt: auditLog.createdAt,
        action: auditLog.action,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        risk: auditLog.risk,
        before: auditLog.before,
        after: auditLog.after,
        reason: auditLog.reason,
        ip: auditLog.ip,
        actorId: auditLog.actorUserId,
        actorName: users.displayName,
        deviceName: devices.name,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .leftJoin(devices, eq(devices.id, auditLog.deviceId))
      .where(where)
      .orderBy(desc(auditLog.id))
      .limit(limit);
  }
}

