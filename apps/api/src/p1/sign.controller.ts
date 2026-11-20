import { Body, Controller, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { media, rentals, sessions, withTenant, type Db } from '@rental/db';
import { eq, sql } from 'drizzle-orm';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import { audit } from '../common/audit.js';
import { dbCall } from '../common/db-errors.js';
import { AppError, parse } from '../common/http.js';
import { RateLimiter } from '../common/rate-limit.js';
import { STORAGE, type Storage } from '../common/storage.js';
import { DB } from '../infra.js';
import { Auth, type AuthCtx } from '../auth/context.js';
import { verifyPassword } from '../auth/crypto.js';
import { SessionGuard } from '../auth/session.guard.js';
import { MAX_SIGNATURE_BYTES, sniffImage, uuidv7, type UploadedFileLike } from './files.js';

const signBody = z.object({
  signerName: z.string().trim().min(2).max(100),
  // multipart ส่งค่าเป็นข้อความ
  accepted: z.preprocess((v) => v === true || v === 'true', z.literal(true, { message: 'terms_not_accepted' })),
});
const confirmBody = z.object({ password: z.string().min(1).max(128) });

/** ลูกค้าเซ็นสัญญาบนเครื่องของร้าน (mock 1.05) · บันทึกลายเซ็นเป็นรูป PNG */
@Controller('v1/rentals')
@UseGuards(SessionGuard)
export class SignController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE) private readonly storage: Storage,
  ) {}

  /** ยื่นเครื่องให้ลูกค้า: session นี้ใช้ได้เฉพาะสัญญานี้จนพนักงานใส่รหัสผ่าน (confirm-staff) */
  @Post(':id/customer-mode')
  @HttpCode(204)
  async customerMode(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string) {
    if (a.customerModeRentalId === id) return; // อยู่ในโหมดนี้แล้ว (รีโหลดหน้าเซ็น) · ไม่ต้องบันทึกซ้ำ
    await withTenant(this.db, a, async (tx) => {
      const [r] = await tx.select({ status: rentals.status }).from(rentals).where(eq(rentals.id, id));
      if (!r) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
      if (r.status !== 'active') throw new AppError(HttpStatus.CONFLICT, 'rental_closed');
      await tx.update(sessions).set({ customerModeRentalId: id }).where(eq(sessions.id, a.sessionId));
      await audit(tx, a, { action: 'rental.customer_mode_started', entityType: 'rental', entityId: id });
    });
  }

  @Post(':id/sign')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('signature', { storage: memoryStorage(), limits: { fileSize: MAX_SIGNATURE_BYTES, files: 1, fields: 10, parts: 12 } }))
  async sign(@Auth() a: AuthCtx, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: UploadedFileLike | undefined, @Body() body: unknown) {
    const input = parse(signBody, body);
    if (!file || !file.size) throw new AppError(HttpStatus.BAD_REQUEST, 'signature_required');
    const type = sniffImage(file.buffer);
    if (type?.contentType !== 'image/png') throw new AppError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'signature_png_only');

    // ตรวจสัญญาก่อนเก็บไฟล์ จะได้ไม่มีไฟล์ค้างถ้าสัญญาใช้ไม่ได้
    await withTenant(this.db, a, async (tx) => {
      const [r] = await tx.select({ status: rentals.status, signedAt: rentals.signedAt }).from(rentals).where(eq(rentals.id, id));
      if (!r) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
      if (r.status !== 'active') throw new AppError(HttpStatus.CONFLICT, 'rental_closed');
      if (r.signedAt) throw new AppError(HttpStatus.CONFLICT, 'already_signed');
    });

    const key = `org/${a.orgId}/signature/${uuidv7()}.png`;
    await this.storage.put(key, file.buffer, 'image/png');
    try {
      return await dbCall(() =>
        withTenant(this.db, a, async (tx) => {
          // ล็อกแถวสัญญา กันสองเครื่องเซ็นพร้อมกัน
          const [r] = await tx.select({ status: rentals.status, signedAt: rentals.signedAt }).from(rentals).where(eq(rentals.id, id)).for('update');
          if (!r || r.status !== 'active') throw new AppError(HttpStatus.CONFLICT, 'rental_closed');
          if (r.signedAt) throw new AppError(HttpStatus.CONFLICT, 'already_signed');
          const [m] = await tx
            .insert(media)
            .values({ orgId: a.orgId, kind: 'signature', slot: 'signature', rentalId: id, storageKey: key, contentType: 'image/png', sizeBytes: file.size, createdBy: a.userId })
            .returning({ id: media.id });
          const signedAt = new Date();
          await tx.update(rentals).set({ signedAt, signerName: input.signerName }).where(eq(rentals.id, id));
          await audit(tx, a, { action: 'rental.signed', entityType: 'rental', entityId: id, after: { signerName: input.signerName, signatureMediaId: m!.id } });
          return { rentalId: id, signedAt, signerName: input.signerName, signatureMediaId: m!.id };
        }),
      );
    } catch (e) {
      await this.storage.remove(key).catch(() => undefined);
      throw e;
    }
  }
}

/** ออกจากหน้าลูกค้าเซ็น: พนักงานที่เข้าระบบอยู่ต้องใส่รหัสผ่านของตัวเองซ้ำ */
@Controller('v1/auth')
@UseGuards(SessionGuard)
export class ConfirmStaffController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly limiter: RateLimiter,
  ) {}

  @Post('confirm-staff')
  @HttpCode(200)
  async confirm(@Auth() a: AuthCtx, @Body() body: unknown) {
    const { password } = parse(confirmBody, body);
    await this.limiter.hit('confirm-staff', a.userId, 10, 600);
    // หารหัสจาก id ของคนที่เข้าระบบอยู่ (ไม่หาจากชื่อผู้ใช้ ที่อาจชนกับเบอร์โทรของคนอื่น)
    const r = await this.db.execute<{ h: string | null }>(sql`select auth.password_hash_of(${a.userId}) as h`);
    const ok = await verifyPassword(r.rows[0]?.h ?? null, password);
    if (!ok) throw new AppError(HttpStatus.UNAUTHORIZED, 'wrong_password');
    if (a.customerModeRentalId) {
      await withTenant(this.db, a, async (tx) => {
        await tx.update(sessions).set({ customerModeRentalId: null }).where(eq(sessions.id, a.sessionId));
        await audit(tx, a, { action: 'rental.customer_mode_ended', entityType: 'rental', entityId: a.customerModeRentalId });
      });
    }
    return { ok: true };
  }
}
