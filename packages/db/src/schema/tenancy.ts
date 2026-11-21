import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const id = () => uuid().primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

/** ร้าน (tenant) · ทุกตารางข้อมูลร้านมี org_id และถูกกั้นด้วย RLS */
export const orgs = pgTable(
  'orgs',
  {
    id: id(),
    slug: text().notNull(),
    name: text().notNull(),
    timezone: text().notNull().default('Asia/Bangkok'),
    currency: text().notNull().default('THB'),
    locale: text().notNull().default('th'),
    status: text().notNull().default('active'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('orgs_slug_key').on(sql`lower(${t.slug})`),
    check('orgs_status_check', sql`${t.status} in ('active', 'suspended', 'closed')`),
    check('orgs_slug_format', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,40}$'`),
  ],
);

/** ค่ากฎของร้าน · ร้านแก้เองได้ทุกค่า (ค่าเริ่มต้น = ร้านต้นแบบเกาะเต่า) */
export const orgSettings = pgTable(
  'org_settings',
  {
    orgId: uuid()
      .primaryKey()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    lateGraceMinutes: integer().notNull().default(60),
    lateHalfDayUntilMinutes: integer().notNull().default(240),
    maxRentalDays: integer().default(15),
    /** มัดจำลูกค้านอกโรงแรม (หน่วยย่อย) · null = ยังไม่ตั้ง */
    depositNonGuest: bigint({ mode: 'number' }),
    /** ส่วนลดเกินนี้ต้องให้เจ้าของอนุมัติ (หน่วยย่อย) */
    staffDiscountCap: bigint({ mode: 'number' }).notNull().default(10_000),
    docRetentionDays: integer().notNull().default(90),
    idleLockMinutes: integer().notNull().default(15),
    /** เปิดหน้าจองสาธารณะ (ร้านใหม่ปิดไว้ก่อน) */
    publicBookingEnabled: boolean().notNull().default(false),
    /** ช่องทางติดต่อร้านที่แสดงบนหน้า QR/หน้าจอง · เก็บเป็นตัวเลขล้วน (มี + นำหน้าได้) */
    contactWhatsapp: text(),
    contactPhone: text(),
    updatedAt: createdAt(),
  },
  (t) => [
    check('org_settings_contact_check', sql`(${t.contactWhatsapp} is null or ${t.contactWhatsapp} ~ '^[+]?[0-9]{8,15}$') and (${t.contactPhone} is null or ${t.contactPhone} ~ '^[+]?[0-9]{8,15}$')`),
    check('org_settings_late_check', sql`${t.lateGraceMinutes} >= 0 and ${t.lateHalfDayUntilMinutes} >= ${t.lateGraceMinutes}`),
    check('org_settings_positive', sql`${t.docRetentionDays} > 0 and ${t.idleLockMinutes} > 0 and ${t.staffDiscountCap} >= 0`),
  ],
);

/** สาขา · ร้านต้นแบบมี 1 สาขา แต่ SaaS ต้องรองรับหลายสาขาตั้งแต่ต้น */
export const branches = pgTable(
  'branches',
  {
    id: id(),
    orgId: uuid()
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    address: text(),
    createdAt: createdAt(),
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index('branches_org_idx').on(t.orgId)],
);

/**
 * ผู้ใช้ระดับแพลตฟอร์ม · คนเดียวเป็นสมาชิกได้หลายร้าน
 * username / phone ไม่ซ้ำทั้งระบบ เพราะหน้าเข้าระบบไม่ถามว่าเป็นร้านไหน
 */
export const users = pgTable(
  'users',
  {
    id: id(),
    username: text().notNull(),
    displayName: text().notNull(),
    phone: text(),
    email: text(),
    passwordHash: text(),
    failedLogins: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
    passwordChangedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    disabledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('users_username_key').on(sql`lower(${t.username})`),
    uniqueIndex('users_phone_key').on(t.phone),
    uniqueIndex('users_email_key').on(sql`lower(${t.email})`),
    check('users_username_format', sql`${t.username} ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$'`),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    orgId: uuid()
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text().notNull(),
    status: text().notNull().default('active'),
    /** ส่วนลดสูงสุดที่ให้เองได้ (หน่วยย่อย) · null = ตามค่าของร้าน */
    discountLimit: bigint({ mode: 'number' }),
    createdAt: createdAt(),
    closedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    index('memberships_user_idx').on(t.userId),
    check('memberships_role_check', sql`${t.role} in ('owner', 'manager', 'staff')`),
    check('memberships_status_check', sql`${t.status} in ('active', 'closed')`),
  ],
);

/** ลิงก์เชิญ · เก็บเฉพาะ hash ของ token · ใช้ได้ครั้งเดียว */
export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    orgId: uuid()
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull(),
    kind: text().notNull().default('invite'),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    username: text().notNull(),
    displayName: text().notNull(),
    phone: text(),
    role: text().notNull(),
    invitedBy: uuid()
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('invitations_token_key').on(t.tokenHash),
    index('invitations_org_idx').on(t.orgId),
    check('invitations_kind_check', sql`${t.kind} in ('invite', 'reset')`),
    check('invitations_role_check', sql`${t.role} in ('owner', 'manager', 'staff')`),
  ],
);

/**
 * เครื่องที่ใช้เข้าระบบ · ผูกกับร้าน (เครื่องหน้าร้านใช้ร่วมกันหลายคน)
 * เครื่องเก็บ secret แบบสุ่มไว้ในตัว ฐานข้อมูลเก็บเฉพาะ hash
 */
export const devices = pgTable(
  'devices',
  {
    id: id(),
    orgId: uuid()
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    secretHash: text().notNull(),
    name: text().notNull(),
    userAgent: text(),
    status: text().notNull().default('pending'),
    approvalCode: text().notNull(),
    requestedBy: uuid()
      .notNull()
      .references(() => users.id),
    approvedBy: uuid().references(() => users.id),
    approvedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    lastSeenAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('devices_secret_key').on(t.orgId, t.secretHash),
    index('devices_org_idx').on(t.orgId),
    check('devices_status_check', sql`${t.status} in ('pending', 'approved', 'revoked')`),
  ],
);

/** session แบบ token ทึบ · เก็บ hash · หมดอายุตามเวลาว่างและอายุสูงสุด */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tokenHash: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid()
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    deviceId: uuid().references(() => devices.id, { onDelete: 'cascade' }),
    ip: text(),
    createdAt: createdAt(),
    lastSeenAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    /** โหมดลูกค้า (ยื่นเครื่องให้ลูกค้าเซ็น) · FK ไป rentals อยู่ใน migration 0009 */
    customerModeRentalId: uuid(),
    /** ยืนยันรหัส 6 หลักล่าสุดใน session นี้ (งานสำคัญไม่ถามซ้ำ 15 นาที) · ตั้งผ่าน auth.totp_* เท่านั้น */
    totpVerifiedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex('sessions_token_key').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

/**
 * ยืนยันตัวตน 2 ชั้น (TOTP) ของผู้ใช้ · ข้อมูลระดับบุคคล ไม่ใช่ของร้าน จึงไม่มี org_id
 * API อ่าน/เขียนตรงไม่ได้ (ไม่มีสิทธิ์ตาราง) · ใช้ฟังก์ชัน auth.totp_* เท่านั้น
 * secret เข้ารหัสด้วยกุญแจของ API (AES-256-GCM) ก่อนเก็บ
 */
export const userTotp = pgTable('user_totp', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secretEnc: text().notNull(),
  /** null = ตั้งค่าอยู่ ยังไม่ยืนยันรหัสแรก */
  enabledAt: timestamp({ withTimezone: true }),
  /** ช่วงเวลา 30 วินาทีล่าสุดที่ใช้ไปแล้ว · กันใช้รหัสเดิมซ้ำ */
  lastStep: bigint({ mode: 'number' }),
  failedCount: integer().notNull().default(0),
  lockedUntil: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
});

/** รหัสสำรอง 8 ชุด (เก็บเฉพาะ hash) · ใช้ได้รหัสละครั้ง */
export const userBackupCodes = pgTable(
  'user_backup_codes',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text().notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('user_backup_codes_key').on(t.userId, t.codeHash)],
);

/** ประวัติการใช้งาน · เพิ่มได้อย่างเดียว ลบหรือแก้ไม่ได้ (บังคับที่ฐานข้อมูล) */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid()
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    actorUserId: uuid().references(() => users.id),
    deviceId: uuid().references(() => devices.id),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: text(),
    risk: text().notNull().default('normal'),
    before: jsonb(),
    after: jsonb(),
    reason: text(),
    ip: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_org_time_idx').on(t.orgId, t.createdAt),
    check('audit_log_risk_check', sql`${t.risk} in ('normal', 'risky')`),
  ],
);

/**
 * outbox: เหตุการณ์ที่ต้องส่งออกนอกระบบ (Marketplace, WhatsApp, webhook ของพาร์ทเนอร์)
 * เขียนในธุรกรรมเดียวกับข้อมูลจริง แล้ว worker ส่งออกทีหลัง จึงไม่มีเหตุการณ์หายหรือส่งก่อนข้อมูลบันทึกสำเร็จ
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: id(),
    orgId: uuid()
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    payload: jsonb().notNull(),
    createdAt: createdAt(),
    publishedAt: timestamp({ withTimezone: true }),
    attempts: integer().notNull().default(0),
  },
  (t) => [index('outbox_unpublished_idx').on(t.createdAt).where(sql`${t.publishedAt} is null`)],
);
