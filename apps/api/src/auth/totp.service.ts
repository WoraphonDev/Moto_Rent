import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { orgs, users, withTenant, type Db } from '@rental/db';
import { eq, sql } from 'drizzle-orm';
import { audit } from '../common/audit.js';
import { AppError, pgError } from '../common/http.js';
import { CONFIG, totpKey, type Config } from '../config.js';
import { DB } from '../infra.js';
import type { AuthCtx } from './context.js';
import { verifyPassword } from './crypto.js';
import { backupHash, matchTotp, newBackupCodes, newTotpSecret, openSecret, otpauthUri, sealSecret } from './totp.js';

/** array ของ hash (hex ล้วน) เป็นรูปแบบ text[] ของ Postgres · drizzle แตก array JS เป็นหลายพารามิเตอร์ */
const pgTextArray = (xs: string[]) => `{${xs.join(',')}}`;

/** งานสำคัญไม่ถามรหัสซ้ำภายในกี่นาที */
export const TOTP_RECENT_MINUTES = 15;
const MAX_FAIL = 5;
const LOCK_MINUTES = 15;

export interface TotpInput {
  code?: string | undefined;
  backupCode?: string | undefined;
}

type State = {
  secret_enc: string;
  enabled: boolean;
  locked: boolean;
  backup_left: number;
};

/**
 * ยืนยันตัวตน 2 ชั้น · ตรวจรหัสที่ API (กุญแจถอดรหัสอยู่ที่นี่) แล้วบันทึกผลผ่าน auth.totp_* ในฐานข้อมูล
 * ฐานข้อมูลเป็นคนกันใช้รหัสช่วงเดิมซ้ำ และนับการใส่ผิด (ใช้ร่วมกันทุกเซิร์ฟเวอร์)
 */
@Injectable()
export class TotpService {
  private readonly key: Buffer;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) config: Config,
  ) {
    this.key = totpKey(config);
  }

  async state(userId: string): Promise<State | null> {
    const r = await this.db.execute<State>(sql`select * from auth.totp_state(${userId})`);
    return r.rows[0] ?? null;
  }

  async status(a: AuthCtx) {
    const s = await this.state(a.userId);
    return { enabled: !!s?.enabled, backupLeft: s?.enabled ? s.backup_left : 0, required: a.role === 'owner' };
  }

  /** เริ่มตั้งค่า: secret ใหม่ + ลิงก์ QR · ยังไม่เปิดจนกว่าจะยืนยันรหัสแรก */
  async begin(a: AuthCtx) {
    const secret = newTotpSecret();
    try {
      await this.db.execute(sql`select auth.totp_begin(${a.userId}, ${sealSecret(this.key, secret)})`);
    } catch (e) {
      if (pgError(e).message?.includes('totp_already_enabled')) throw new AppError(HttpStatus.CONFLICT, 'totp_already_enabled');
      throw e;
    }
    const [who] = await withTenant(this.db, a, (tx) =>
      tx.select({ username: users.username, shop: orgs.name }).from(users).innerJoin(orgs, eq(orgs.id, a.orgId)).where(eq(users.id, a.userId)),
    );
    return { secret, uri: otpauthUri(`Rental · ${who?.shop ?? 'shop'}`, who?.username ?? 'user', secret) };
  }

  /** ยืนยันรหัสแรก → เปิดใช้ · คืนรหัสสำรอง (แสดงครั้งเดียว) · session นี้นับว่ายืนยันแล้ว */
  async enable(a: AuthCtx, code: string) {
    const s = await this.state(a.userId);
    if (!s) throw new AppError(HttpStatus.CONFLICT, 'totp_not_set');
    if (s.enabled) throw new AppError(HttpStatus.CONFLICT, 'totp_already_enabled');
    await this.checkCode(a.userId, s, code, { enable: true, sessionId: a.sessionId });
    const codes = newBackupCodes();
    await this.db.execute(sql`select auth.totp_set_backup(${a.userId}, ${pgTextArray(codes.map(backupHash))}::text[])`);
    await withTenant(this.db, a, (tx) => audit(tx, a, { action: 'auth.totp_enabled', entityType: 'user', entityId: a.userId }));
    return { backupCodes: codes };
  }

  /** ยืนยันสำหรับงานสำคัญ (session นี้ไม่ถามซ้ำ 15 นาที) */
  async verify(a: AuthCtx, input: TotpInput) {
    await this.check(a.userId, input, a.sessionId);
    await withTenant(this.db, a, (tx) => audit(tx, a, { action: 'auth.totp_verified', entityType: 'session', entityId: a.sessionId }));
  }

  /** ตรวจตอนเข้าระบบจากเครื่องใหม่ (ยังไม่มี session) */
  async verifyLogin(userId: string, input: TotpInput) {
    await this.check(userId, input, null);
  }

  async regenerateBackup(a: AuthCtx) {
    await this.requireRecent(a, true);
    const codes = newBackupCodes();
    await this.db.execute(sql`select auth.totp_set_backup(${a.userId}, ${pgTextArray(codes.map(backupHash))}::text[])`);
    await withTenant(this.db, a, (tx) => audit(tx, a, { action: 'auth.totp_backup_regenerated', entityType: 'user', entityId: a.userId, risk: 'risky' }));
    return { backupCodes: codes };
  }

  /** ปิด: ต้องใส่ทั้งรหัสผ่านและรหัส 6 หลัก/รหัสสำรอง */
  async disable(a: AuthCtx, password: string, input: TotpInput) {
    const r = await this.db.execute<{ h: string | null }>(sql`select auth.password_hash_of(${a.userId}) as h`);
    if (!(await verifyPassword(r.rows[0]?.h ?? null, password))) throw new AppError(HttpStatus.UNAUTHORIZED, 'invalid_credentials');
    await this.check(a.userId, input, null);
    await this.db.execute(sql`select auth.totp_disable(${a.userId})`);
    await withTenant(this.db, a, (tx) => audit(tx, a, { action: 'auth.totp_disabled', entityType: 'user', entityId: a.userId, risk: 'risky' }));
  }

  /**
   * งานสำคัญของเจ้าของร้าน (อนุมัติเครื่อง ลิงก์ตั้งรหัสใหม่ เชิญพนักงาน)
   * ยังไม่เปิด 2 ชั้น → 403 totp_setup_required · เปิดแล้วแต่ยังไม่ยืนยันใน 15 นาที → 403 totp_required
   */
  async requireRecent(a: AuthCtx, anyRole = false) {
    if (!anyRole && a.role !== 'owner') return;
    const r = await this.db.execute<{ ok: boolean }>(sql`select auth.totp_recent(${a.sessionId}, ${a.userId}, ${TOTP_RECENT_MINUTES}) as ok`);
    if (r.rows[0]?.ok) return;
    const s = await this.state(a.userId);
    throw new AppError(HttpStatus.FORBIDDEN, s?.enabled ? 'totp_required' : 'totp_setup_required');
  }

  private async check(userId: string, input: TotpInput, sessionId: string | null) {
    const s = await this.state(userId);
    if (!s?.enabled) throw new AppError(HttpStatus.CONFLICT, 'totp_not_set');
    if (input.backupCode) {
      const r = await this.db.execute<{ r: string }>(
        sql`select auth.totp_use_backup(${userId}, ${backupHash(input.backupCode)}, ${sessionId}, ${MAX_FAIL}, ${LOCK_MINUTES}) as r`,
      );
      this.raise(r.rows[0]?.r);
      return;
    }
    if (!input.code) throw new AppError(HttpStatus.BAD_REQUEST, 'totp_code_required');
    await this.checkCode(userId, s, input.code, { enable: false, sessionId });
  }

  private async checkCode(userId: string, s: State, code: string, o: { enable: boolean; sessionId: string | null }) {
    const step = matchTotp(openSecret(this.key, s.secret_enc), code);
    const r = await this.db.execute<{ r: string }>(
      sql`select auth.totp_check(${userId}, ${step !== null}, ${step ?? 0}, ${o.enable}, ${o.sessionId}, ${MAX_FAIL}, ${LOCK_MINUTES}) as r`,
    );
    this.raise(r.rows[0]?.r);
  }

  private raise(result: string | undefined) {
    if (result === 'ok') return;
    if (result === 'locked') throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'totp_locked');
    if (result === 'not_set') throw new AppError(HttpStatus.CONFLICT, 'totp_not_set');
    throw new AppError(HttpStatus.UNAUTHORIZED, 'totp_invalid');
  }
}
