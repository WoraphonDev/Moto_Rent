import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.ts';

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function createDb(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max });
  // connection ว่างถูกตัดได้ (รีสตาร์ทฐานข้อมูล/failover) · ถ้าไม่ดัก process จะล้ม · pool เปิดใหม่เองตอน query ถัดไป
  pool.on('error', (err) => console.warn(`[db] idle connection dropped: ${err.message}`));
  return drizzle({ client: pool, schema, casing: 'snake_case' });
}

export interface TenantContext {
  userId: string | null;
  /** null สำหรับงานที่ยังไม่ผูกร้าน เช่น เลือกร้านหลังเข้าระบบ */
  orgId: string | null;
}

/**
 * รันงานในธุรกรรมที่ตั้ง app.user_id / app.org_id ให้ RLS
 * ค่าเป็นแบบ local ของธุรกรรม จึงไม่รั่วไปคำขออื่นที่ใช้ connection เดียวกันใน pool
 */
export function withTenant<T>(db: Db, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.user_id', ${ctx.userId ?? ''}, true), set_config('app.org_id', ${ctx.orgId ?? ''}, true)`,
    );
    return fn(tx);
  });
}
