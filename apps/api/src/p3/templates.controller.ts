import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { billLines, bills, bookingItems, bookings, customers, messageTemplates, orgs, rentalItems, rentals, assets, assetTypes, assetVariants, withTenant, type Db } from '@rental/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../common/audit.js';
import { AppError, parse } from '../common/http.js';
import { DB } from '../infra.js';
import { Auth, Roles, type AuthCtx } from '../auth/context.js';
import { SessionGuard } from '../auth/session.guard.js';

export const TEMPLATE_KEYS = ['booking_confirmed', 'booking_rejected', 'return_reminder', 'receipt', 'thank_you'] as const;
type Key = (typeof TEMPLATE_KEYS)[number];

/** ข้อความเริ่มต้น (ภาษาอังกฤษ เพราะลูกค้าส่วนใหญ่เป็นชาวต่างชาติ) · ร้านแก้ได้ */
export const DEFAULT_TEMPLATES: Record<Key, string> = {
  booking_confirmed:
    'Hi {name}, your booking {code} at {shop} is confirmed.\nPickup: {pickup}\nVehicle: {vehicle}\nPlease bring your passport and driving licence. No online payment needed, pay at the shop. See you soon!',
  booking_rejected: "Hi {name}, sorry, we can't confirm booking {code} at {shop} for {pickup}. Reply here and we'll suggest another time.",
  return_reminder: 'Hi {name}, a friendly reminder from {shop}: please return {vehicle} by {return_time}. Need more days? Just reply here.',
  receipt: 'Hi {name}, thank you for renting with {shop}. Total paid: {total}. Receipt: {code}.',
  thank_you: 'Thank you for riding with {shop}, {name}! If you enjoyed it, a short review would help us a lot.',
};
export const TEMPLATE_VARIABLES = ['{name}', '{code}', '{vehicle}', '{pickup}', '{return_time}', '{total}', '{shop}'];

const putBody = z.object({ body: z.string().trim().min(5).max(1000) });
const renderBody = z
  .object({ bookingId: z.string().uuid().optional(), rentalId: z.string().uuid().optional(), billId: z.string().uuid().optional() })
  .refine((v) => [v.bookingId, v.rentalId, v.billId].filter(Boolean).length === 1, 'exactly_one_target');

function keyOf(raw: string): Key {
  if (!(TEMPLATE_KEYS as readonly string[]).includes(raw)) throw new AppError(HttpStatus.NOT_FOUND, 'template_not_found');
  return raw as Key;
}

function fill(body: string, vars: Record<string, string>) {
  return body.replace(/\{(name|code|vehicle|pickup|return_time|total|shop)\}/g, (_, k: string) => vars[k] ?? '');
}

const bahtText = (minor: number) => `THB ${(minor / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/**
 * เทมเพลตข้อความ WhatsApp (mock 3.W3)
 * ส่งแบบกดเอง: ระบบเติมข้อความแล้วเปิด WhatsApp (ฟรี) · ส่งอัตโนมัติต้องใช้ WhatsApp Business API (มีค่าใช้จ่าย) ภายหลัง
 */
@Controller('v1/message-templates')
@UseGuards(SessionGuard)
export class TemplatesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Auth() a: AuthCtx) {
    return withTenant(this.db, a, async (tx) => {
      const saved = await tx.select().from(messageTemplates);
      return TEMPLATE_KEYS.map((key) => {
        const s = saved.find((x) => x.key === key);
        return { key, body: s?.body ?? DEFAULT_TEMPLATES[key], isDefault: !s, defaultBody: DEFAULT_TEMPLATES[key], updatedAt: s?.updatedAt ?? null, variables: TEMPLATE_VARIABLES };
      });
    });
  }

  @Put(':key')
  @Roles('owner', 'manager')
  async put(@Auth() a: AuthCtx, @Param('key') raw: string, @Body() body: unknown) {
    const key = keyOf(raw);
    const input = parse(putBody, body);
    return withTenant(this.db, a, async (tx) => {
      const [before] = await tx.select().from(messageTemplates).where(eq(messageTemplates.key, key));
      await tx
        .insert(messageTemplates)
        .values({ orgId: a.orgId, key, body: input.body, updatedBy: a.userId })
        .onConflictDoUpdate({ target: [messageTemplates.orgId, messageTemplates.key], set: { body: input.body, updatedBy: a.userId, updatedAt: new Date() } });
      await audit(tx, a, { action: 'message_template.updated', entityType: 'message_template', entityId: key, before: { body: before?.body ?? DEFAULT_TEMPLATES[key] }, after: { body: input.body } });
      return { key, body: input.body, isDefault: false };
    });
  }

  /** เหมือน PUT (หน้าเว็บใช้ PATCH ผ่านตัวเรียก API กลาง) */
  @Patch(':key')
  @Roles('owner', 'manager')
  async patch(@Auth() a: AuthCtx, @Param('key') raw: string, @Body() body: unknown) {
    return this.put(a, raw, body);
  }

  /** เติมตัวแปรจากคำขอจอง / สัญญา / บิล แล้วคืนลิงก์ wa.me ให้กดส่งเอง */
  @Post(':key/render')
  @HttpCode(200)
  async render(@Auth() a: AuthCtx, @Param('key') raw: string, @Body() body: unknown) {
    const key = keyOf(raw);
    const target = parse(renderBody, body);
    return withTenant(this.db, a, async (tx) => {
      const [org] = await tx.select({ name: orgs.name, tz: orgs.timezone }).from(orgs).where(eq(orgs.id, a.orgId));
      const tz = org?.tz ?? 'Asia/Bangkok';
      const when = (d: Date) => d.toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const vars: Record<string, string> = { shop: org?.name ?? '' };
      let phone = '';

      if (target.bookingId) {
        const [b] = await tx.select().from(bookings).where(eq(bookings.id, target.bookingId));
        if (!b) throw new AppError(HttpStatus.NOT_FOUND, 'booking_not_found');
        const items = await tx
          .select({ typeName: assetTypes.name, code: assets.code, size: assetVariants.label, qty: bookingItems.quantity, price: bookingItems.pricePerDay })
          .from(bookingItems)
          .innerJoin(assetTypes, eq(assetTypes.id, bookingItems.assetTypeId))
          .leftJoin(assets, eq(assets.id, bookingItems.assetId))
          .leftJoin(assetVariants, eq(assetVariants.id, bookingItems.variantId))
          .where(eq(bookingItems.bookingId, b.id));
        Object.assign(vars, {
          name: b.fullName,
          code: b.code,
          pickup: when(b.pickupAt),
          return_time: when(new Date(b.pickupAt.getTime() + b.days * 86_400_000)),
          vehicle: items.map((i) => (i.size ? `${i.typeName} ${i.size} x${i.qty}` : `${i.typeName}${i.code ? ` (${i.code})` : ''}`)).join(', '),
          total: bahtText(items.reduce((s, i) => s + i.price * i.qty * b.days, 0)),
        });
        phone = b.whatsapp;
      } else if (target.rentalId) {
        const [r] = await tx
          .select({ rental: rentals, name: customers.fullName, phone: customers.phone })
          .from(rentals)
          .innerJoin(customers, eq(customers.id, rentals.customerId))
          .where(eq(rentals.id, target.rentalId));
        if (!r) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        const items = await tx
          .select({ typeName: assetTypes.name, code: assets.code, size: assetVariants.label, qty: rentalItems.quantity })
          .from(rentalItems)
          .innerJoin(assetTypes, eq(assetTypes.id, rentalItems.assetTypeId))
          .leftJoin(assets, eq(assets.id, rentalItems.assetId))
          .leftJoin(assetVariants, eq(assetVariants.id, rentalItems.variantId))
          .where(eq(rentalItems.rentalId, r.rental.id));
        const [sum] = await tx.select({ t: sql<number>`coalesce(sum(${billLines.amount}), 0)`.mapWith(Number) }).from(billLines).where(eq(billLines.rentalId, r.rental.id));
        Object.assign(vars, {
          name: r.name,
          code: '',
          pickup: when(r.rental.startAt),
          return_time: when(r.rental.dueAt),
          vehicle: items.map((i) => (i.code ? `${i.typeName} ${i.code}` : `${i.typeName} ${i.size} x${i.qty}`)).join(', '),
          total: bahtText(sum?.t ?? 0),
        });
        phone = r.phone ?? '';
      } else if (target.billId) {
        const [b] = await tx
          .select({ bill: bills, name: customers.fullName, phone: customers.phone })
          .from(bills)
          .innerJoin(customers, eq(customers.id, bills.customerId))
          .where(eq(bills.id, target.billId));
        if (!b) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
        const [sum] = await tx.select({ t: sql<number>`coalesce(sum(${billLines.amount}), 0)`.mapWith(Number) }).from(billLines).where(eq(billLines.billId, b.bill.id));
        const [active] = await tx
          .select({ due: rentals.dueAt })
          .from(rentals)
          .where(and(eq(rentals.customerId, b.bill.customerId), eq(rentals.status, 'active'), isNull(rentals.returnedAt)))
          .limit(1);
        Object.assign(vars, { name: b.name, code: b.bill.receiptNo ?? '', total: bahtText(sum?.t ?? 0), vehicle: '', pickup: '', return_time: active ? when(active.due) : '' });
        phone = b.phone ?? '';
      }

      const [saved] = await tx.select().from(messageTemplates).where(eq(messageTemplates.key, key));
      const text = fill(saved?.body ?? DEFAULT_TEMPLATES[key], vars);
      const digits = phone.replace(/\D/g, '');
      return { key, text, phone: digits || null, waUrl: `https://wa.me/${digits}?text=${encodeURIComponent(text)}` };
    });
  }
}
