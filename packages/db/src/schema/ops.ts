import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { assets, assetTypes, assetVariants, customers, rentals } from './rental.ts';
import { branches, orgs, users } from './tenancy.ts';

const id = () => uuid().primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const orgId = () =>
  uuid()
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' });
const money = () => bigint({ mode: 'number' });

// ---------------------------------------------------------------- เฟส 1 (ส่วนที่เหลือ)

/**
 * รูปและไฟล์ (เก็บตัวไฟล์บน S3/R2 · ตารางนี้เก็บแค่ที่อยู่)
 * - vehicle_photo: รูปรถ 6 มุมตอนปล่อย/รับคืน (slot = front/back/left/right/odometer/fuel/damage)
 * - document: พาสปอร์ต/ใบขับขี่ · ลบอัตโนมัติตาม delete_after (PDPA) · การเปิดดูทุกครั้งบันทึกใน audit_log
 * - signature: ลายเซ็นลูกค้าบนสัญญา
 * - maintenance_receipt: ใบเสร็จค่าซ่อม
 * - cover: รูปหน้าปกของประเภท (asset_type_id) หรือของคัน (asset_id) · ไม่มีกำหนดลบ · ถูกแทนที่แล้วตั้งกำหนดลบไฟล์เก่า
 */
export const media = pgTable(
  'media',
  {
    id: id(),
    orgId: orgId(),
    kind: text().notNull(),
    slot: text(),
    stage: text(),
    rentalId: uuid().references(() => rentals.id),
    customerId: uuid().references(() => customers.id),
    assetId: uuid().references(() => assets.id),
    assetTypeId: uuid().references(() => assetTypes.id),
    maintenanceId: uuid(),
    storageKey: text().notNull(),
    contentType: text().notNull(),
    sizeBytes: integer().notNull(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    deleteAfter: timestamp({ withTimezone: true }),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('media_rental_idx').on(t.rentalId),
    index('media_customer_idx').on(t.customerId),
    index('media_purge_idx').on(t.deleteAfter).where(sql`${t.deletedAt} is null and ${t.deleteAfter} is not null`),
    uniqueIndex('media_storage_key').on(t.storageKey),
    check('media_kind_check', sql`${t.kind} in ('vehicle_photo', 'document', 'signature', 'maintenance_receipt', 'cover')`),
    check('media_stage_check', sql`${t.stage} is null or ${t.stage} in ('checkout', 'return')`),
    check('media_size_check', sql`${t.sizeBytes} > 0 and ${t.sizeBytes} <= 15728640`),
  ],
);

/** ปิดยอดสิ้นวัน: นับเงินสดในลิ้นชักเทียบกับที่ระบบคาด · ปิดแล้วแก้ไม่ได้ */
export const dayCloses = pgTable(
  'day_closes',
  {
    id: id(),
    orgId: orgId(),
    branchId: uuid().references(() => branches.id),
    businessDate: date({ mode: 'string' }).notNull(),
    expectedCash: money().notNull(),
    countedCash: money().notNull(),
    expectedOther: money().notNull().default(0),
    note: text(),
    closedBy: uuid()
      .notNull()
      .references(() => users.id),
    closedAt: createdAt(),
  },
  (t) => [uniqueIndex('day_closes_org_date_key').on(t.orgId, t.businessDate)],
);

// ---------------------------------------------------------------- เฟส 2

/** ประวัติซ่อมบำรุงต่อคัน · ใช้คำนวณกำไรต่อคันในรายงาน */
export const maintenanceRecords = pgTable(
  'maintenance_records',
  {
    id: id(),
    orgId: orgId(),
    assetId: uuid()
      .notNull()
      .references(() => assets.id),
    kind: text().notNull(),
    description: text().notNull(),
    cost: money().notNull().default(0),
    odometer: integer(),
    performedOn: date({ mode: 'string' }).notNull(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('maintenance_asset_idx').on(t.assetId, t.performedOn),
    check('maintenance_kind_check', sql`${t.kind} in ('oil', 'tire', 'brake', 'repair', 'insurance', 'tax', 'other')`),
    check('maintenance_cost_check', sql`${t.cost} >= 0`),
  ],
);

/** ปรับสต็อกของนับจำนวน (ซื้อเพิ่ม / ชำรุด / หาย) · ทุกครั้งต้องมีเหตุผล */
export const stockAdjustments = pgTable(
  'stock_adjustments',
  {
    id: id(),
    orgId: orgId(),
    variantId: uuid()
      .notNull()
      .references(() => assetVariants.id),
    delta: integer().notNull(),
    reason: text().notNull(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('stock_adjustments_variant_idx').on(t.variantId), check('stock_adjustments_delta_check', sql`${t.delta} <> 0`)],
);

// ---------------------------------------------------------------- เฟส 3

/** เทมเพลตข้อความ WhatsApp ของร้าน (ยืนยันจอง · ปฏิเสธ · เตือนก่อนคืน · ใบเสร็จ · ขอบคุณ) */
export const messageTemplates = pgTable(
  'message_templates',
  {
    orgId: orgId(),
    key: text().notNull(),
    body: text().notNull(),
    updatedBy: uuid().references(() => users.id),
    updatedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.key] }), check('message_templates_key_check', sql`${t.key} in ('booking_confirmed', 'booking_rejected', 'return_reminder', 'receipt', 'thank_you')`)],
);

/**
 * คำขอจองจากลูกค้า (หน้าจองสาธารณะ / Marketplace ในอนาคต)
 * ลูกค้าไม่มีบัญชี · ดู/ยกเลิกผ่านลิงก์ส่วนตัว (เก็บเฉพาะ hash ของ token)
 */
export const bookings = pgTable(
  'bookings',
  {
    id: id(),
    orgId: orgId(),
    code: text().notNull(),
    status: text().notNull().default('requested'),
    channel: text().notNull().default('booking_page'),
    fullName: text().notNull(),
    whatsapp: text().notNull(),
    email: text(),
    hotelRoom: text(),
    checkoutDate: date({ mode: 'string' }),
    hasLicense: boolean().notNull().default(false),
    pickupAt: timestamp({ withTimezone: true }).notNull(),
    days: integer().notNull(),
    notes: text(),
    source: text(),
    manageTokenHash: text().notNull(),
    customerId: uuid().references(() => customers.id),
    rentalId: uuid().references(() => rentals.id),
    rejectReason: text(),
    decidedBy: uuid().references(() => users.id),
    decidedAt: timestamp({ withTimezone: true }),
    ip: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('bookings_org_code_key').on(t.orgId, t.code),
    uniqueIndex('bookings_token_key').on(t.manageTokenHash),
    index('bookings_org_status_idx').on(t.orgId, t.status, t.pickupAt),
    check('bookings_status_check', sql`${t.status} in ('requested', 'confirmed', 'rejected', 'cancelled', 'picked_up', 'no_show')`),
    check('bookings_channel_check', sql`${t.channel} in ('booking_page', 'marketplace', 'phone')`),
    check('bookings_days_check', sql`${t.days} between 1 and 60`),
  ],
);

/**
 * ของในคำขอจอง · ยืนยันแล้วกำหนดคันได้ (asset_id) · คอลัมน์ during (tstzrange) และกฎกันจองซ้อน
 * อยู่ใน migration แบบ SQL (drizzle ยังไม่รองรับ range type)
 * active = ยังกันของอยู่ (คำขอที่ยืนยันแล้วและยังไม่รับรถ/ยกเลิก)
 */
export const bookingItems = pgTable(
  'booking_items',
  {
    id: id(),
    orgId: orgId(),
    bookingId: uuid()
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    assetTypeId: uuid()
      .notNull()
      .references(() => assetTypes.id),
    variantId: uuid().references(() => assetVariants.id),
    assetId: uuid().references(() => assets.id),
    quantity: integer().notNull().default(1),
    pricePerDay: money().notNull(),
    active: boolean().notNull().default(false),
  },
  (t) => [index('booking_items_booking_idx').on(t.bookingId), check('booking_items_quantity_check', sql`${t.quantity} > 0`)],
);
