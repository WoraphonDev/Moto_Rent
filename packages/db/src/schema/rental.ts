import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { branches, orgs, users } from './tenancy.ts';

const id = () => uuid().primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const orgId = () =>
  uuid()
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' });
/** เงินเป็นจำนวนเต็มหน่วยย่อย (สตางค์) */
const money = () => bigint({ mode: 'number' });

/**
 * ประเภทของให้เช่า · ร้านกำหนดเอง ไม่ผูกกับ "รถ"
 * - unit: รายชิ้น มีรหัส/ทะเบียน (Click C-01, ATV A-01) → ตาราง assets
 * - quantity: นับจำนวน แยกไซส์ (ตีนกบ S/M/L) → ตาราง asset_variants
 */
export const assetTypes = pgTable(
  'asset_types',
  {
    id: id(),
    orgId: orgId(),
    name: text().notNull(),
    /** ชื่อที่ลูกค้าเห็น (หน้าจอง หน้าเซ็นสัญญา Marketplace) · null = ใช้ name */
    publicName: text(),
    tracking: text().notNull(),
    codePrefix: text(),
    pricePerDay: money().notNull(),
    deposit: money(),
    listedOnMarketplace: boolean().notNull().default(false),
    /** เปลี่ยนน้ำมันเครื่องทุกกี่ กม. · null = ไม่ติดตาม */
    serviceIntervalKm: integer(),
    /** รูปหน้าปกของประเภท (ใช้กับทุกคันที่ไม่มีรูปของตัวเอง + หน้าจอง) · FK → media เพิ่มใน migration 0013 (media อยู่ใน ops.ts) */
    coverMediaId: uuid(),
    sortOrder: integer().notNull().default(0),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('asset_types_org_idx').on(t.orgId),
    check('asset_types_tracking_check', sql`${t.tracking} in ('unit', 'quantity')`),
    check('asset_types_public_name_check', sql`${t.publicName} is null or char_length(${t.publicName}) between 1 and 60`),
    check('asset_types_price_check', sql`${t.pricePerDay} >= 0 and coalesce(${t.deposit}, 0) >= 0`),
  ],
);

/** ของรายชิ้น 1 ชิ้น (รถ 1 คัน) */
export const assets = pgTable(
  'assets',
  {
    id: id(),
    orgId: orgId(),
    assetTypeId: uuid()
      .notNull()
      .references(() => assetTypes.id),
    branchId: uuid().references(() => branches.id),
    code: text().notNull(),
    model: text(),
    plate: text(),
    color: text(),
    odometer: integer(),
    /** สถานะที่คนตั้ง · "ถูกเช่า" ไม่เก็บตรงนี้ แต่ดูจาก rental_items ที่ยังไม่คืน (ไม่มีทางไม่ตรงกัน) */
    status: text().notNull().default('available'),
    /** ราคาเฉพาะคัน · null = ใช้ราคาของประเภท */
    pricePerDay: money(),
    notes: text(),
    insuranceExpiresOn: date({ mode: 'string' }),
    taxExpiresOn: date({ mode: 'string' }),
    nextServiceOdometer: integer(),
    /** รูปหน้าปกเฉพาะคัน (ทับรูปของประเภท) · FK → media เพิ่มใน migration 0013 */
    coverMediaId: uuid(),
    /** token ในสติกเกอร์ QR บนตัวรถ · สุ่ม ไม่ซ้ำทั้งระบบ (token บอกได้เองว่าเป็นของร้านไหน) · หมุนใหม่ได้ */
    qrToken: text()
      .notNull()
      .default(sql`replace(gen_random_uuid()::text, '-', '')`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('assets_qr_token_key').on(t.qrToken),
    uniqueIndex('assets_org_code_key').on(t.orgId, sql`upper(${t.code})`),
    index('assets_type_idx').on(t.assetTypeId),
    check('assets_status_check', sql`${t.status} in ('available', 'maintenance', 'retired')`),
  ],
);

/** ของนับจำนวน แยกไซส์ (ตีนกบ L × 10) */
export const assetVariants = pgTable(
  'asset_variants',
  {
    id: id(),
    orgId: orgId(),
    assetTypeId: uuid()
      .notNull()
      .references(() => assetTypes.id),
    label: text().notNull(),
    quantity: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('asset_variants_type_label_key').on(t.assetTypeId, t.label),
    check('asset_variants_quantity_check', sql`${t.quantity} >= 0`),
  ],
);

export const customers = pgTable(
  'customers',
  {
    id: id(),
    orgId: orgId(),
    fullName: text().notNull(),
    nationality: text(),
    phone: text(),
    email: text(),
    hotelRoom: text(),
    /** วันเช็คเอาท์โรงแรม · ใช้เตือน "เช็คเอาท์วันนี้แต่ยังค้างจ่าย" */
    checkoutDate: date({ mode: 'string' }),
    notes: text(),
    doNotRent: boolean().notNull().default(false),
    doNotRentReason: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('customers_org_idx').on(t.orgId),
    index('customers_room_idx').on(t.orgId, t.hotelRoom),
    check('customers_dnr_reason', sql`not ${t.doNotRent} or ${t.doNotRentReason} is not null`),
  ],
);

/** สัญญาเช่า 1 ใบ · id สร้างจากเครื่องได้ (uuidv7) เพื่อให้ส่งซ้ำตอนเน็ตหลุดแล้วไม่เกิดสัญญาซ้อน */
export const rentals = pgTable(
  'rentals',
  {
    id: uuid().primaryKey(),
    orgId: orgId(),
    branchId: uuid().references(() => branches.id),
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    status: text().notNull().default('active'),
    channel: text().notNull().default('walk_in'),
    startAt: timestamp({ withTimezone: true }).notNull(),
    dueAt: timestamp({ withTimezone: true }).notNull(),
    returnedAt: timestamp({ withTimezone: true }),
    paymentMode: text().notNull().default('at_checkout'),
    deposit: money(),
    notes: text(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    returnedBy: uuid().references(() => users.id),
    signedAt: timestamp({ withTimezone: true }),
    signerName: text(),
    bookingId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    index('rentals_org_status_idx').on(t.orgId, t.status, t.dueAt),
    index('rentals_customer_idx').on(t.customerId),
    check('rentals_status_check', sql`${t.status} in ('active', 'returned', 'cancelled')`),
    check('rentals_channel_check', sql`${t.channel} in ('walk_in', 'hotel', 'booking_page', 'marketplace')`),
    check('rentals_payment_check', sql`${t.paymentMode} in ('at_checkout', 'pay_now')`),
    check('rentals_dates_check', sql`${t.dueAt} > ${t.startAt}`),
  ],
);

/**
 * ของในสัญญา · ของรายชิ้นอ้าง asset_id · ของนับจำนวนอ้าง variant_id + quantity
 * released_at = เวลาที่ของกลับเข้าร้าน (คืน/ยกเลิก)
 * unique index บังคับว่าของรายชิ้นอยู่ในสัญญาที่ยังไม่คืนได้แค่ใบเดียว · กันปล่อยรถคันเดียวซ้อนกันแม้มีหลายเซิร์ฟเวอร์
 */
export const rentalItems = pgTable(
  'rental_items',
  {
    id: id(),
    orgId: orgId(),
    rentalId: uuid()
      .notNull()
      .references(() => rentals.id, { onDelete: 'cascade' }),
    assetTypeId: uuid()
      .notNull()
      .references(() => assetTypes.id),
    assetId: uuid().references(() => assets.id),
    variantId: uuid().references(() => assetVariants.id),
    quantity: integer().notNull().default(1),
    pricePerDay: money().notNull(),
    releasedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('rental_items_one_active_per_asset').on(t.assetId).where(sql`${t.assetId} is not null and ${t.releasedAt} is null`),
    index('rental_items_rental_idx').on(t.rentalId),
    index('rental_items_variant_active_idx').on(t.variantId).where(sql`${t.releasedAt} is null`),
    check('rental_items_target_check', sql`(${t.assetId} is not null and ${t.variantId} is null and ${t.quantity} = 1) or (${t.assetId} is null and ${t.variantId} is not null and ${t.quantity} > 0)`),
  ],
);

/**
 * บิล = บัญชีของลูกค้า 1 คนช่วงที่พัก · รวมทุกสัญญาและค่าเพิ่ม (mock 1.07 "หนึ่งบิลต่อหนึ่งห้อง")
 * ลูกค้า 1 คนมีบิลเปิดได้ใบเดียว
 */
export const bills = pgTable(
  'bills',
  {
    id: id(),
    orgId: orgId(),
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    status: text().notNull().default('open'),
    /** เลขใบเสร็จ ออกตอนจ่ายครบ (รันต่อเนื่องต่อร้าน) */
    receiptNo: text(),
    paidAt: timestamp({ withTimezone: true }),
    voidedAt: timestamp({ withTimezone: true }),
    voidReason: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('bills_one_open_per_customer').on(t.customerId).where(sql`${t.status} = 'open'`),
    uniqueIndex('bills_receipt_key').on(t.orgId, t.receiptNo),
    index('bills_org_status_idx').on(t.orgId, t.status),
    check('bills_status_check', sql`${t.status} in ('open', 'paid', 'void')`),
  ],
);

/** รายการในบิล · เพิ่มได้อย่างเดียว แก้ยอดด้วยการเพิ่มรายการปรับ (ส่วนลดเป็นยอดติดลบ) */
export const billLines = pgTable(
  'bill_lines',
  {
    id: id(),
    orgId: orgId(),
    billId: uuid()
      .notNull()
      .references(() => bills.id, { onDelete: 'cascade' }),
    rentalId: uuid().references(() => rentals.id),
    kind: text().notNull(),
    description: text().notNull(),
    amount: money().notNull(),
    reason: text(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('bill_lines_bill_idx').on(t.billId),
    check('bill_lines_kind_check', sql`${t.kind} in ('rental', 'extension', 'late_fee', 'fuel', 'damage', 'gear', 'discount', 'other')`),
    check('bill_lines_discount_check', sql`(${t.kind} = 'discount') = (${t.amount} < 0)`),
    check('bill_lines_reason_check', sql`${t.kind} not in ('discount', 'other') or ${t.reason} is not null`),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    orgId: orgId(),
    billId: uuid()
      .notNull()
      .references(() => bills.id),
    method: text().notNull(),
    amount: money().notNull(),
    receivedBy: uuid()
      .notNull()
      .references(() => users.id),
    /** id จากเครื่อง · ส่งซ้ำ (โหมดออฟไลน์) แล้วไม่รับเงินซ้ำ */
    clientId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    index('payments_bill_idx').on(t.billId),
    uniqueIndex('payments_client_key').on(t.orgId, t.clientId),
    index('payments_org_time_idx').on(t.orgId, t.createdAt),
    check('payments_method_check', sql`${t.method} in ('cash', 'promptpay', 'transfer', 'card')`),
    check('payments_amount_check', sql`${t.amount} > 0`),
  ],
);

/** ตัวนับเลขเอกสารต่อร้าน (เลขใบเสร็จ) · เพิ่มแบบ atomic ด้วย UPDATE ... RETURNING */
export const orgCounters = pgTable(
  'org_counters',
  {
    orgId: orgId(),
    name: text().notNull(),
    value: bigint({ mode: 'number' }).notNull().default(0),
  },
  (t) => [uniqueIndex('org_counters_key').on(t.orgId, t.name)],
);
