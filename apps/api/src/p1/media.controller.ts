import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { media, orgSettings, users, withTenant, type Db } from '@rental/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import { audit } from '../common/audit.js';
import { dbCall } from '../common/db-errors.js';
import { AppError, parse } from '../common/http.js';
import { STORAGE, type Storage } from '../common/storage.js';
import { DB } from '../infra.js';
import { Auth, Roles, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';
import { MAX_IMAGE_BYTES, sniffImage, uuidv7, type UploadedFileLike } from './files.js';
import { PurgeService } from './purge.service.js';

const uploadBody = z
  .object({
    kind: z.enum(['vehicle_photo', 'document', 'maintenance_receipt']),
    slot: z.enum(['front', 'back', 'left', 'right', 'odometer', 'fuel', 'damage', 'passport', 'license', 'other']).optional(),
    stage: z.enum(['checkout', 'return']).optional(),
    rentalId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    assetId: z.string().uuid().optional(),
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
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 10, parts: 12 } }))
  async upload(@Auth() a: AuthCtx, @UploadedFile() file: UploadedFileLike | undefined, @Body() body: unknown) {
    const input = parse(uploadBody, body);
    if (!file || !file.size) throw new AppError(HttpStatus.BAD_REQUEST, 'file_required');
    const type = sniffImage(file.buffer);
    if (!type) throw new AppError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'image_only');

    const key = `org/${a.orgId}/${input.kind}/${uuidv7()}.${type.ext}`;
    await this.storage.put(key, file.buffer, type.contentType);
    try {
      return await dbCall(() =>
        withTenant(this.db, a, async (tx) => {
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
      if (a.customerModeRentalId && (m.rentalId !== a.customerModeRentalId || m.kind === 'document')) {
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
  async purgeNow() {
    return { purged: await this.purge.runOnce() };
  }
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
    maintenanceId: m.maintenanceId,
    contentType: m.contentType,
    sizeBytes: m.sizeBytes,
    createdAt: m.createdAt,
    deleteAfter: m.deleteAfter,
  };
}
