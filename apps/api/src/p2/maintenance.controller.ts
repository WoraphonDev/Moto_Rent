import { Body, Controller, Get, HttpStatus, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { assets, assetTypes, maintenanceRecords, users, withTenant, type Db } from '@rental/db';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../common/audit.js';
import { dbCall } from '../common/db-errors.js';
import { AppError, parse } from '../common/http.js';
import { DB } from '../infra.js';
import { Auth, Roles, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';
import { localToday, orgTimezone } from './common.js';

/** ใกล้ถึงรอบน้ำมันเครื่องเมื่อเหลือไม่เกินกี่ กม. */
export const OIL_SOON_KM = 300;
/** เอกสาร (พ.ร.บ./ภาษี) ใกล้หมดเมื่อเหลือไม่เกินกี่วัน */
export const EXPIRY_SOON_DAYS = 30;

const date = z.string().date();
const recordBody = z.object({
  assetId: z.string().uuid(),
  kind: z.enum(['oil', 'tire', 'brake', 'repair', 'insurance', 'tax', 'other']),
  description: z.string().trim().min(1).max(300),
  cost: z.number().int().min(0).max(100_000_000).default(0),
  odometer: z.number().int().min(0).optional(),
  performedOn: date,
  /** ต่อ พ.ร.บ./ภาษี: วันหมดอายุใหม่ */
  newExpiry: date.optional(),
});
const serviceInfoBody = z.object({
  insuranceExpiresOn: date.nullable().optional(),
  taxExpiresOn: date.nullable().optional(),
  nextServiceOdometer: z.number().int().min(0).nullable().optional(),
});
const intervalBody = z.object({ serviceIntervalKm: z.number().int().min(100).max(100_000).nullable() });

type Urgency = 'overdue' | 'soon' | 'ok';
interface DueItem {
  kind: 'oil' | 'insurance' | 'tax';
  urgency: Urgency;
  /** oil: กม. ที่เหลือ (ติดลบ = เลยมาแล้ว) · insurance/tax: วันที่เหลือ */
  remaining: number;
  dueAt: string | number;
}

function daysBetween(today: string, target: string) {
  return Math.round((Date.parse(target) - Date.parse(today)) / 86_400_000);
}

/** สิ่งที่ถึงกำหนดของรถ 1 คัน (ฟังก์ชันล้วน ใช้ในเทสต์ได้) */
export function dueFor(a: { odometer: number | null; nextServiceOdometer: number | null; insuranceExpiresOn: string | null; taxExpiresOn: string | null }, today: string): DueItem[] {
  const out: DueItem[] = [];
  if (a.nextServiceOdometer !== null && a.odometer !== null) {
    const left = a.nextServiceOdometer - a.odometer;
    out.push({ kind: 'oil', urgency: left <= 0 ? 'overdue' : left <= OIL_SOON_KM ? 'soon' : 'ok', remaining: left, dueAt: a.nextServiceOdometer });
  }
  for (const [kind, on] of [['insurance', a.insuranceExpiresOn], ['tax', a.taxExpiresOn]] as const) {
    if (!on) continue;
    const left = daysBetween(today, on);
    out.push({ kind, urgency: left < 0 ? 'overdue' : left <= EXPIRY_SOON_DAYS ? 'soon' : 'ok', remaining: left, dueAt: on });
  }
  return out;
}

const RANK: Record<Urgency, number> = { overdue: 0, soon: 1, ok: 2 };

/** ซ่อมบำรุง (mock 2.02 / 2.W2) */
@Controller('v1')
@UseGuards(SessionGuard)
export class MaintenanceController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** รถทุกคัน (ยกเว้นปลดระวาง) + สิ่งที่ถึงกำหนด เรียงคันที่ด่วนที่สุดก่อน */
  @Get('maintenance/due')
  async due(@Auth() a: AuthCtx) {
    return withTenant(this.db, a, async (tx) => {
      const today = await localToday(tx, await orgTimezone(tx, a.orgId));
      const rows = await tx
        .select({
          id: assets.id,
          code: assets.code,
          model: assets.model,
          status: assets.status,
          odometer: assets.odometer,
          nextServiceOdometer: assets.nextServiceOdometer,
          insuranceExpiresOn: assets.insuranceExpiresOn,
          taxExpiresOn: assets.taxExpiresOn,
          typeName: assetTypes.name,
          serviceIntervalKm: assetTypes.serviceIntervalKm,
        })
        .from(assets)
        .innerJoin(assetTypes, eq(assetTypes.id, assets.assetTypeId))
        .where(sql`${assets.status} <> 'retired'`)
        .orderBy(assets.code);
      const list = rows.map((r) => {
        const items = dueFor(r, today);
        const worst = items.reduce<Urgency>((w, i) => (RANK[i.urgency] < RANK[w] ? i.urgency : w), 'ok');
        return { ...r, items, urgency: worst };
      });
      list.sort((x, y) => RANK[x.urgency] - RANK[y.urgency] || x.code.localeCompare(y.code));
      return { today, assets: list };
    });
  }

  @Get('maintenance')
  async list(@Auth() a: AuthCtx, @Query('assetId') assetId?: string, @Query('from') from?: string, @Query('to') to?: string) {
    if (assetId && !z.string().uuid().safeParse(assetId).success) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_input');
    return withTenant(this.db, a, (tx) =>
      tx
        .select({
          id: maintenanceRecords.id,
          assetId: maintenanceRecords.assetId,
          code: assets.code,
          kind: maintenanceRecords.kind,
          description: maintenanceRecords.description,
          cost: maintenanceRecords.cost,
          odometer: maintenanceRecords.odometer,
          performedOn: maintenanceRecords.performedOn,
          by: users.displayName,
          createdAt: maintenanceRecords.createdAt,
        })
        .from(maintenanceRecords)
        .innerJoin(assets, eq(assets.id, maintenanceRecords.assetId))
        .innerJoin(users, eq(users.id, maintenanceRecords.createdBy))
        .where(
          and(
            assetId ? eq(maintenanceRecords.assetId, assetId) : undefined,
            from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? gte(maintenanceRecords.performedOn, from) : undefined,
            to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? lt(maintenanceRecords.performedOn, sql`(${to}::date + 1)`) : undefined,
          ),
        )
        .orderBy(desc(maintenanceRecords.performedOn), desc(maintenanceRecords.createdAt))
        .limit(300),
    );
  }

  @Post('maintenance')
  async create(@Auth() a: AuthCtx, @Body() body: unknown) {
    const input = parse(recordBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [asset] = await tx
          .select({ id: assets.id, odometer: assets.odometer, interval: assetTypes.serviceIntervalKm, insurance: assets.insuranceExpiresOn, tax: assets.taxExpiresOn, next: assets.nextServiceOdometer })
          .from(assets)
          .innerJoin(assetTypes, eq(assetTypes.id, assets.assetTypeId))
          .where(eq(assets.id, input.assetId));
        if (!asset) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        const [row] = await tx
          .insert(maintenanceRecords)
          .values({
            orgId: a.orgId,
            assetId: input.assetId,
            kind: input.kind,
            description: input.description,
            cost: input.cost,
            odometer: input.odometer ?? null,
            performedOn: input.performedOn,
            createdBy: a.userId,
          })
          .returning();

        // อัปเดตข้อมูลรถตามงานที่ทำ
        const patch: Partial<typeof assets.$inferInsert> = {};
        if (input.odometer !== undefined && (asset.odometer === null || input.odometer > asset.odometer)) patch.odometer = input.odometer;
        if (input.kind === 'oil') {
          const base = input.odometer ?? asset.odometer;
          if (asset.interval && base !== null) patch.nextServiceOdometer = base + asset.interval;
        }
        if (input.kind === 'insurance' && input.newExpiry) patch.insuranceExpiresOn = input.newExpiry;
        if (input.kind === 'tax' && input.newExpiry) patch.taxExpiresOn = input.newExpiry;
        if (Object.keys(patch).length) await tx.update(assets).set(patch).where(eq(assets.id, input.assetId));

        await audit(tx, a, {
          action: 'maintenance.recorded',
          entityType: 'asset',
          entityId: input.assetId,
          before: Object.keys(patch).length ? { odometer: asset.odometer, nextServiceOdometer: asset.next, insuranceExpiresOn: asset.insurance, taxExpiresOn: asset.tax } : null,
          after: { kind: input.kind, description: input.description, cost: input.cost, ...patch },
        });
        return { ...row!, assetUpdate: patch };
      }),
    );
  }

  @Patch('assets/:id/service-info')
  @Roles('owner', 'manager')
  async serviceInfo(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(serviceInfoBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [before] = await tx
          .select({ insuranceExpiresOn: assets.insuranceExpiresOn, taxExpiresOn: assets.taxExpiresOn, nextServiceOdometer: assets.nextServiceOdometer })
          .from(assets)
          .where(eq(assets.id, id));
        if (!before) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        const [row] = await tx.update(assets).set(input).where(eq(assets.id, id)).returning();
        await audit(tx, a, { action: 'asset.service_info_updated', entityType: 'asset', entityId: id, before, after: input });
        return row;
      }),
    );
  }

  @Patch('asset-types/:id/service-interval')
  @Roles('owner', 'manager')
  async interval(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(intervalBody, body);
    return dbCall(() =>
      withTenant(this.db, a, async (tx) => {
        const [before] = await tx.select({ v: assetTypes.serviceIntervalKm, tracking: assetTypes.tracking }).from(assetTypes).where(eq(assetTypes.id, id));
        if (!before) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        if (before.tracking !== 'unit') throw new AppError(HttpStatus.BAD_REQUEST, 'type_not_unit');
        const [row] = await tx.update(assetTypes).set({ serviceIntervalKm: input.serviceIntervalKm }).where(eq(assetTypes.id, id)).returning();
        await audit(tx, a, { action: 'asset_type.service_interval_changed', entityType: 'asset_type', entityId: id, before: { serviceIntervalKm: before.v }, after: input });
        return row;
      }),
    );
  }
}
