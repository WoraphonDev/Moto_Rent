import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { assets, assetTypes, media, orgSettings, users, withTenant, type Db, type Tx } from '@rental/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import { audit } from '../common/audit.js';
import { dbCall } from '../common/db-errors.js';
import { AppError, parse } from '../common/http.js';
import { RateLimiter } from '../common/rate-limit.js';
import { STORAGE, type Storage } from '../common/storage.js';
import { DB } from '../infra.js';
import { Auth, Roles, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';
import { MAX_IMAGE_BYTES, sniffImage, uuidv7, type UploadedFileLike } from './files.js';
import { PurgeService } from './purge.service.js';

const uploadBody = z
  .object({
    kind: z.enum(['vehicle_photo', 'document', 'maintenance_receipt', 'cover']),
    slot: z.enum(['front', 'back', 'left', 'right', 'odometer', 'fuel', 'damage', 'passport', 'license', 'other']).optional(),
    stage: z.enum(['checkout', 'return']).optional(),
    rentalId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    assetId: z.string().uuid().optional(),
    /** รูปหน้าปกของประเภท (kind = cover) */
    assetTypeId: z.string().uuid().optional(),
    maintenanceId: z.string().uuid().optional(),
  })
  .superRefine((v, ctx) => {
    const need = (ok: boolean, path: string, message: string) => ok || ctx.addIssue({ code: 'custom', path: [path], message });
    if (v.kind === 'vehicle_photo') {
      need(!!v.rentalId, 'rentalId', 'rental_required');
      need(!!v.stage, 'stage', 'stage_required');
      need(!!v.slot && ['front', 'back', 'left', 'right', 'odometer', 'fuel', 'damage'].includes(v.slot), 'slot', 'slot_invalid');
    }
    if (v.kind === 'document') {
      need(!!v.customerId, 'customerId', 'customer_required');
      need(!!v.slot && ['passport', 'license', 'other'].includes(v.slot), 'slot', 'slot_invalid');
    }
    if (v.kind === 'maintenance_receipt') need(!!v.maintenanceId || !!v.assetId, 'maintenanceId', 'maintenance_required');
    // รูปหน้าปก: ระบุเป้าหมายอย่างใดอย่างหนึ่ง (ประเภท หรือ คัน) และไม่ผูกกับสัญญา/ลูกค้า/งานซ่อม
    if (v.kind === 'cover') {
      need(!!v.assetTypeId !== !!v.assetId, 'assetTypeId', 'cover_target_required');
      need(!v.rentalId && !v.customerId && !v.maintenanceId && !v.slot && !v.stage, 'kind', 'cover_extra_fields');
    }
    if (v.kind !== 'cover') need(!v.assetTypeId, 'assetTypeId', 'cover_only');
  });

const listQuery = z
  .object({ rentalId: z.string().uuid().optional(), customerId: z.string().uuid().optional(), maintenanceId: z.string().uuid().optional() })
  .refine((q) => q.rentalId || q.customerId || q.maintenanceId, 'filter_required');

/** รูปรถ เอกสารลูกค้า ใบเสร็จค่าซ่อม · ไฟล์ทุกไฟล์ส่งผ่าน API (ตรวจสิทธิ์ + บันทึกการเปิดดูเอกสาร) */
@Controller('v1/media')
@UseGuards(SessionGuard)
export class MediaController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE) private readonly storage: Storage,
    private readonly purge: PurgeService,
    private readonly limiter: RateLimiter,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 10, parts: 12 } }))
  async upload(@Auth() a: AuthCtx, @UploadedFile() file: UploadedFileLike | undefined, @Body() body: unknown) {
    const input = parse(uploadBody, body);
    // รูปหน้าปกเปลี่ยนได้เฉพาะเจ้าของ/ผู้จัดการ (ตรวจก่อนเก็บไฟล์)
    if (input.kind === 'cover' && a.role !== 'owner' && a.role !== 'manager') throw new AppError(HttpStatus.FORBIDDEN, 'forbidden');
    if (!file || !file.size) throw new AppError(HttpStatus.BAD_REQUEST, 'file_required');
    const type = sniffImage(file.buffer);
    if (!type) throw new AppError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'image_only');

    const key = `org/${a.orgId}/${input.kind}/${uuidv7()}.${type.ext}`;
    await this.storage.put(key, file.buffer, type.contentType);
    try {
      return await dbCall(() =>
        withTenant(this.db, a, async (tx) => {
          if (input.kind === 'cover') return this.setCover(tx, a, input, { key, contentType: type.contentType, size: file.size });
          let deleteAfter: Date | null = null;
          if (input.kind === 'document') {
            const [s] = await tx.select({ days: orgSettings.docRetentionDays }).from(orgSettings).where(eq(orgSettings.orgId, a.orgId));
            deleteAfter = new Date(Date.now() + (s?.days ?? 90) * 86_400_000);
          }
          const [row] = await tx
            .insert(media)
            .values({
              orgId: a.orgId,
              kind: input.kind,
              slot: input.slot ?? null,
              stage: input.kind === 'vehicle_photo' ? (input.stage ?? null) : null,
              rentalId: input.rentalId ?? null,
              customerId: input.customerId ?? null,
              assetId: input.assetId ?? null,
              maintenanceId: input.maintenanceId ?? null,
              storageKey: key,
              contentType: type.contentType,
              sizeBytes: file.size,
              createdBy: a.userId,
              deleteAfter,
            })
            .returning();
          await audit(tx, a, {
            action: 'media.uploaded',
            entityType: 'media',
            entityId: row!.id,
            after: { kind: row!.kind, slot: row!.slot, stage: row!.stage, rentalId: row!.rentalId, customerId: row!.customerId },
          });
          return publicRow(row!);
        }),
      );
    } catch (e) {
      // บันทึกแถวไม่สำเร็จ (เช่น อ้างสัญญาของร้านอื่น) → ลบไฟล์ที่เพิ่งเก็บทิ้ง
      await this.storage.remove(key).catch(() => undefined);
      throw e;
    }
  }

  @Get()
  async list(@Auth() a: AuthCtx, @Query() query: unknown) {
    const q = parse(listQuery, query);
    return withTenant(this.db, a, async (tx) => {
      const rows = await tx
        .select({ m: media, by: users.displayName })
        .from(media)
        .innerJoin(users, eq(users.id, media.createdBy))
        .where(
          and(
            isNull(media.deletedAt),
            q.rentalId ? eq(media.rentalId, q.rentalId) : undefined,
            q.customerId ? eq(media.customerId, q.customerId) : undefined,
            q.maintenanceId ? eq(media.maintenanceId, q.maintenanceId) : undefined,
          ),
        )
        .orderBy(asc(media.createdAt));
      return rows.map((r) => ({ ...publicRow(r.m), by: r.by }));
    });
  }

  /** ส่งตัวไฟล์ · เปิดดูเอกสารลูกค้าทุกครั้งเข้าประวัติการใช้งาน */
  @Get(':id/content')
  async content(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const row = await withTenant(this.db, a, async (tx) => {
      const [m] = await tx.select().from(media).where(and(eq(media.id, id), isNull(media.deletedAt)));
      if (!m) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
      if (a.customerModeRentalId && !(await customerModeMayView(tx, m, a.customerModeRentalId))) {
        throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
      }
      if (m.kind === 'document') {
        await audit(tx, a, { action: 'document.viewed', entityType: 'media', entityId: m.id, after: { customerId: m.customerId, slot: m.slot } });
      }
      return m;
    });
    const file = await this.storage.get(row.storageKey).catch(() => null);
    if (!file) throw new AppError(HttpStatus.NOT_FOUND, 'file_missing');
    res.setHeader('Content-Type', row.contentType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    if (file.size) res.setHeader('Content-Length', String(file.size));
    file.body.on('error', () => res.destroy());
    file.body.pipe(res);
  }

  /** ลบเอกสารที่ครบกำหนดทันที (ปกติงานเบื้องหลังทำทุกชั่วโมง) */
  @Post('purge-now')
  @HttpCode(200)
  @Roles('owner')
  async purgeNow(@Auth() a: AuthCtx) {
    // เดิมลบของทุกร้านในระบบ และกดรัวได้ · ตอนนี้เฉพาะร้านตัวเอง ร้านละไม่เกิน 10 ครั้ง/ชม.
    await this.limiter.hit('purge-now', a.orgId, 10, 3600);
    const purged = await this.purge.runForOrg(a);
    await withTenant(this.db, a, (tx) => audit(tx, a, { action: 'media.purge_now', entityType: 'org', entityId: a.orgId, after: { purged } }));
    return { purged };
  }

  /** เก็บรูปหน้าปกใหม่ + ตั้งเป็นหน้าปกของประเภท/คัน ในธุรกรรมเดียว · รูปเดิมตั้งกำหนดลบ (งานลบไฟล์เก็บกวาดให้) */
  private async setCover(
    tx: Tx,
    a: AuthCtx,
    input: { assetTypeId?: string; assetId?: string },
    file: { key: string; contentType: string; size: number },
  ) {
    const target = input.assetTypeId ? { table: assetTypes, id: input.assetTypeId, entity: 'asset_type' } : { table: assets, id: input.assetId!, entity: 'asset' };
    // ล็อกแถวเป้าหมาย · สองเครื่องเปลี่ยนรูปพร้อมกันแล้วรูปเดิมไม่ค้างเป็นไฟล์กำพร้า
    const [row] = await tx.select({ cover: target.table.coverMediaId }).from(target.table).where(eq(target.table.id, target.id)).for('update');
    if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
    const [m] = await tx
      .insert(media)
      .values({
        orgId: a.orgId,
        kind: 'cover',
        assetId: input.assetId ?? null,
        assetTypeId: input.assetTypeId ?? null,
        storageKey: file.key,
        contentType: file.contentType,
        sizeBytes: file.size,
        createdBy: a.userId,
      })
      .returning();
    await tx.update(target.table).set({ coverMediaId: m!.id }).where(eq(target.table.id, target.id));
    await retireCover(tx, row.cover);
    await audit(tx, a, { action: `${target.entity}.cover_set`, entityType: target.entity, entityId: target.id, before: { coverMediaId: row.cover }, after: { coverMediaId: m!.id } });
    return publicRow(m!);
  }
}

/** รูปหน้าปกที่ถูกแทนที่/เอาออก → ตั้งกำหนดลบทันที · งานลบไฟล์ (purge) ลบไฟล์จริงและบันทึกประวัติ */
export async function retireCover(tx: Tx, mediaId: string | null | undefined) {
  if (!mediaId) return;
  await tx.update(media).set({ deleteAfter: new Date() }).where(and(eq(media.id, mediaId), eq(media.kind, 'cover'), isNull(media.deletedAt)));
}

/**
 * โหมดลูกค้า (หน้าเซ็นสัญญา) เปิดได้เฉพาะ
 * - ไฟล์ของสัญญานี้ที่ไม่ใช่เอกสารลูกค้า
 * - รูปหน้าปกของคัน/ประเภทที่อยู่ในสัญญานี้ (หน้าเซ็นแสดงรูปรถ)
 */
async function customerModeMayView(tx: Tx, m: typeof media.$inferSelect, rentalId: string): Promise<boolean> {
  if (m.kind === 'document') return false;
  if (m.kind !== 'cover') return m.rentalId === rentalId;
  const r = await tx.execute<{ ok: boolean }>(sql`
    select exists (
      select 1 from rental_items ri
      join asset_types t on t.id = ri.asset_type_id
      left join assets a on a.id = ri.asset_id
      where ri.rental_id = ${rentalId} and (t.cover_media_id = ${m.id} or a.cover_media_id = ${m.id})
    ) as ok`);
  return !!r.rows[0]?.ok;
}

function publicRow(m: typeof media.$inferSelect) {
  return {
    id: m.id,
    kind: m.kind,
    slot: m.slot,
    stage: m.stage,
    rentalId: m.rentalId,
    customerId: m.customerId,
    assetId: m.assetId,
    assetTypeId: m.assetTypeId,
    maintenanceId: m.maintenanceId,
    contentType: m.contentType,
    sizeBytes: m.sizeBytes,
    createdAt: m.createdAt,
    deleteAfter: m.deleteAfter,
  };
}
