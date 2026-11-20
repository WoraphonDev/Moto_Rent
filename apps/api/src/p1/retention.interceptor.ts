import { Inject, Injectable, Logger, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { media, orgSettings, withTenant, type Db } from '@rental/db';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { mergeMap, type Observable } from 'rxjs';
import type { AuthedRequest } from '../auth/context.js';
import { DB } from '../infra.js';

const RETURN_PATH = /^\/v1\/rentals\/[0-9a-f-]{36}\/return$/i;

/**
 * กฎเก็บเอกสาร (PDPA): ลบรูปพาสปอร์ต/ใบขับขี่หลัง "คืนรถครั้งล่าสุด" + จำนวนวันที่ร้านตั้ง
 * ตอนอัปโหลดตั้งกำหนดลบไว้ก่อน (อัปโหลด + N วัน) · เมื่อรับคืนสำเร็จ เลื่อนกำหนดเป็น วันคืน + N วัน
 * ทำเป็น interceptor หลังรับคืนสำเร็จ จึงไม่ต้องแก้ controller ของสัญญา และใช้ได้กับการส่งซ้ำจากโหมดออฟไลน์ด้วย
 */
@Injectable()
export class DocumentRetentionInterceptor implements NestInterceptor {
  private readonly log = new Logger('DocumentRetention');

  constructor(@Inject(DB) private readonly db: Db) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (req.method !== 'POST' || !RETURN_PATH.test(req.path)) return next.handle();
    return next.handle().pipe(
      mergeMap(async (result: unknown) => {
        const r = result as { customer?: { id?: string }; returnedAt?: Date | string | null } | undefined;
        if (req.auth && r?.customer?.id && r.returnedAt) {
          await this.extend(req.auth, r.customer.id, new Date(r.returnedAt)).catch((e: Error) => this.log.warn(`could not extend retention: ${e.message}`));
        }
        return result;
      }),
    );
  }

  private async extend(auth: NonNullable<AuthedRequest['auth']>, customerId: string, returnedAt: Date) {
    await withTenant(this.db, auth, async (tx) => {
      const [s] = await tx.select({ days: orgSettings.docRetentionDays }).from(orgSettings).where(eq(orgSettings.orgId, auth.orgId));
      const until = new Date(returnedAt.getTime() + (s?.days ?? 90) * 86_400_000);
      await tx
        .update(media)
        .set({ deleteAfter: until })
        .where(
          and(
            eq(media.customerId, customerId),
            eq(media.kind, 'document'),
            isNull(media.deletedAt),
            or(isNull(media.deleteAfter), lt(media.deleteAfter, sql`${until.toISOString()}::timestamptz`)),
          ),
        );
    });
  }
}
