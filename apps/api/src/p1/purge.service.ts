import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { withTenant, type Db } from '@rental/db';
import type { AuthCtx } from '../auth/context.js';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { STORAGE, type Storage } from '../common/storage.js';
import { DB, VALKEY } from '../infra.js';

const LOCK_KEY = 'lock:media-purge';
const INTERVAL_MS = 60 * 60_000;

/**
 * ลบเอกสารลูกค้าที่ครบกำหนด (PDPA) ทุกชั่วโมง
 * ทุกเครื่องตั้งเวลาไว้ แต่มีเครื่องเดียวที่ได้ล็อกใน Valkey ในแต่ละรอบ จึงไม่ลบซ้ำซ้อน
 * ลบตัวไฟล์ก่อน แล้วค่อยบันทึกว่าลบแล้ว (ถ้าลบไฟล์ไม่สำเร็จ รอบหน้าจะลองใหม่)
 */
@Injectable()
export class PurgeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('MediaPurge');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(STORAGE) private readonly storage: Storage,
  ) {}

  onApplicationBootstrap() {
    // เทสต์เรียก runOnce() เองเท่านั้น
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.timer.unref();
    setTimeout(() => void this.tick(), 60_000).unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    const got = await this.valkey.set(LOCK_KEY, String(process.pid), 'EX', Math.floor(INTERVAL_MS / 1000) - 60, 'NX').catch(() => null);
    if (got !== 'OK') return;
    try {
      const n = await this.runOnce();
      if (n) this.log.log(`purged ${n} expired documents`);
    } catch (e) {
      this.log.warn(`purge failed: ${(e as Error).message}`);
    }
  }

  /** ลบรายการที่เลยกำหนดแล้วของทุกร้าน (งานเบื้องหลัง) · คืนจำนวนที่ลบ */
  async runOnce(): Promise<number> {
    const due = await this.db.execute<{ media_id: string; org_id: string; storage_key: string }>(sql`select * from app.media_due_for_purge(200)`);
    return this.purgeRows(due.rows);
  }

  /** เจ้าของร้านกด "ลบทันที" · เฉพาะของร้านตัวเอง (อ่านผ่าน RLS ของร้านนั้น) */
  async runForOrg(a: Pick<AuthCtx, 'userId' | 'orgId'>): Promise<number> {
    const due = await withTenant(this.db, a, (tx) =>
      tx.execute<{ media_id: string; org_id: string; storage_key: string }>(sql`
        select id as media_id, org_id, storage_key from media
        where deleted_at is null and delete_after is not null and delete_after <= now()
        order by delete_after limit 200`),
    );
    return this.purgeRows(due.rows);
  }

  private async purgeRows(rows: Array<{ media_id: string; org_id: string; storage_key: string }>): Promise<number> {
    let n = 0;
    for (const row of rows) {
      try {
        await this.storage.remove(row.storage_key);
        // trigger กันอ้างข้ามร้านของตาราง media ใช้ app.org_id · ตั้งเป็นร้านของรายการนั้นในธุรกรรมเดียวกัน
        await this.db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.org_id', ${row.org_id}, true)`);
          await tx.execute(sql`select app.mark_media_purged(${row.media_id})`);
        });
        n++;
      } catch (e) {
        this.log.warn(`could not purge ${row.media_id}: ${(e as Error).message}`);
      }
    }
    return n;
  }
}
