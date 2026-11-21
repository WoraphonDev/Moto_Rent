import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Db } from '@rental/db';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { CONFIG, type Config } from '../config.js';
import { AppError, parse, pgError } from '../common/http.js';
import { clientKey, RateLimiter } from '../common/rate-limit.js';
import { STORAGE, type Storage } from '../common/storage.js';
import { DB, VALKEY } from '../infra.js';
import { newToken, tokenHash } from '../auth/crypto.js';

type CoverRow = { media_id: string; storage_key: string; content_type: string };

/** ใช้เวลากรอกฟอร์มน้อยกว่านี้ = น่าจะเป็น bot */
const MIN_FORM_MS = 3000;
/** คำขอจองสูงสุดต่อร้านต่อวัน (กันสแปมท่วมคิวพนักงาน) · ตั้งต่ำลงได้เฉพาะตอนเทสต์ */
const SHOP_DAILY_CAP = Number(process.env.PUBLIC_BOOKING_DAILY_CAP) || 50;
/** ปฏิทินเก็บไว้ใน Valkey (วินาที) · คำขอซ้ำในช่วงนี้ไม่แตะฐานข้อมูล */
const CALENDAR_CACHE_SECONDS = 60;
/** ช่วงเวลาสูงสุดที่ถามความว่างได้ (ตรงกับข้อจำกัดในฐานข้อมูล) */
const MAX_RANGE_MS = 61 * 86_400_000;
/** ข้อความที่ดูเป็นลิงก์ · ห้ามในชื่อ (ชื่อถูกส่งต่อเข้า WhatsApp ของร้าน ใช้หลอกลูกค้าได้) */
const LINK_RE = /https?:|www\.|[a-z0-9-]+\.(com|net|org|io|co|me|ly|xyz|top|tld|link|app|th)\b/i;
const LINK_RE_GLOBAL = /\S*(?:https?:|www\.)\S*|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|me|ly|xyz|top|tld|link|app|th)\b\S*/gi;

/** เบอร์ WhatsApp → ตัวเลขล้วน (คง + ไว้ถ้ามี) · ต้องมีอย่างน้อย 8 หลัก */
export function normalizePhone(raw: string): { phone: string; digits: string } | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return { phone: `${raw.trim().startsWith('+') ? '+' : ''}${digits}`, digits };
}

/** token ในสติกเกอร์ QR (ฐานข้อมูลสร้าง: uuid ตัด - ออก) */
const QR_TOKEN = /^[0-9a-f]{32}$/;
/** รูปหน้าปกแคชได้ (รูปเปลี่ยน = URL เปลี่ยนตาม ?v=) */
const COVER_CACHE = 'public, max-age=3600';

const slugParam = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,40}$/);
const bookingBody = z.object({
  fullName: z.string().trim().min(2).max(100),
  whatsapp: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{8,20}$/, 'phone_format'),
  email: z.string().trim().email().max(120).optional().or(z.literal('')),
  hotelRoom: z.string().trim().max(10).optional(),
  checkoutDate: z.string().date().optional().or(z.literal('')),
  hasLicense: z.boolean(),
  pickupAt: z.string().datetime({ offset: true }),
  days: z.number().int().min(1).max(60),
  notes: z.string().trim().max(500).optional(),
  source: z.string().trim().max(40).optional(),
  items: z
    .array(z.object({ typeId: z.string().uuid(), variantId: z.string().uuid().optional(), quantity: z.number().int().min(1).max(20) }))
    .min(1)
    .max(10),
  /** กับดัก bot: ช่องที่คนมองไม่เห็น ต้องว่าง */
  website: z.string().max(200).optional(),
  /** เวลาเปิดฟอร์ม (ms) · ใช้กันการส่งเร็วเกินคน */
  startedAt: z.number().int(),
});

/**
 * หน้าจองสาธารณะ (mock 3.01–3.04) · ไม่มี session ไม่มี cookie
 * ทุกอย่างผ่านฟังก์ชัน pub.* ในฐานข้อมูลที่คืนเฉพาะสิ่งที่หน้าจองต้องใช้
 */
@Controller('v1/public')
export class PublicBookingController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(STORAGE) private readonly storage: Storage,
    private readonly limiter: RateLimiter,
  ) {}

  @Get('shops/:slug')
  async shop(@Param('slug') slugRaw: string, @Req() req: Request) {
    await this.limiter.hit('pub-read', clientKey(req), 300, 600);
    const slug = await this.enabledSlug(slugRaw);
    const r = await this.db.execute<{ j: Record<string, unknown> | null }>(sql`select pub.shop(${slug}) as j`);
    const shop = r.rows[0]?.j;
    if (!shop) throw new AppError(HttpStatus.NOT_FOUND, 'shop_not_found');
    const { orgId: _hidden, types, ...rest } = shop as { orgId?: string; types?: Array<{ id: string; coverMediaId?: string | null } & Record<string, unknown>> };
    return {
      ...rest,
      // ไม่ส่ง id ของไฟล์ · ส่ง URL ของรูปแทน (ใส่ ?v= ให้รูปใหม่ไม่ติดแคชของรูปเดิม)
      types: (types ?? []).map(({ coverMediaId, ...t }) => ({ ...t, coverUrl: coverMediaId ? `/v1/public/shops/${slug}/types/${t.id}/cover?v=${coverMediaId.slice(-12)}` : null })),
    };
  }

  /** รูปหน้าปกของประเภท (หน้าจอง) · เฉพาะรูปชนิด cover ของร้านที่เปิดหน้าจอง */
  @Get('shops/:slug/types/:typeId/cover')
  async typeCover(@Param('slug') slugRaw: string, @Param('typeId') typeId: string, @Req() req: Request, @Res() res: Response) {
    await this.limiter.hit('pub-read', clientKey(req), 300, 600);
    const slug = this.slug(slugRaw);
    if (!z.string().uuid().safeParse(typeId).success) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
    const r = await this.db.execute<CoverRow>(sql`select * from pub.type_cover(${slug}, ${typeId}::uuid)`);
    await this.sendCover(r.rows[0], res);
  }

  /** สแกน QR บนตัวรถ (ลูกค้า/คนทั่วไป) · คืนเฉพาะข้อมูลร้าน + รหัสคัน + ชื่อประเภท */
  @Get('q/:token')
  async qr(@Param('token') token: string, @Req() req: Request) {
    await this.limiter.hit('pub-qr', clientKey(req), 60, 600);
    if (!QR_TOKEN.test(token)) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
    const r = await this.db.execute<{ j: (Record<string, unknown> & { coverMediaId?: string | null }) | null }>(sql`select pub.qr_lookup(${token}) as j`);
    const j = r.rows[0]?.j;
    if (!j) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
    const { coverMediaId, ...rest } = j;
    return { ...rest, coverUrl: coverMediaId ? `/v1/public/q/${token}/cover?v=${coverMediaId.slice(-12)}` : null };
  }

  /** รูปหน้าปกของคันที่สแกน (ของคันเอง ไม่มีใช้ของประเภท) */
  @Get('q/:token/cover')
  async qrCover(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    await this.limiter.hit('pub-read', clientKey(req), 300, 600);
    if (!QR_TOKEN.test(token)) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
    const r = await this.db.execute<CoverRow>(sql`select * from pub.qr_cover(${token})`);
    await this.sendCover(r.rows[0], res);
  }

  private async sendCover(row: CoverRow | undefined, res: Response) {
    if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
    const file = await this.storage.get(row.storage_key).catch(() => null);
    if (!file) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Cache-Control', COVER_CACHE);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    // หน้าจอง/หน้า QR อยู่คนละ origin กับ API ได้
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (file.size) res.setHeader('Content-Length', String(file.size));
    file.body.on('error', () => res.destroy());
    file.body.pipe(res);
  }

  @Get('shops/:slug/availability')
  async availability(@Param('slug') slugRaw: string, @Query('from') from: string, @Query('to') to: string, @Req() req: Request) {
    await this.limiter.hit('pub-read', clientKey(req), 300, 600);
    const f = new Date(from);
    const t = new Date(to);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || t <= f || t.getTime() - f.getTime() > MAX_RANGE_MS) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_range');
    }
    const slug = await this.enabledSlug(slugRaw);
    try {
      const r = await this.db.execute<{ j: unknown }>(sql`select pub.availability(${slug}, ${f.toISOString()}::timestamptz, ${t.toISOString()}::timestamptz) as j`);
      if (!r.rows[0]?.j) throw new AppError(HttpStatus.NOT_FOUND, 'shop_not_found');
      return r.rows[0].j;
    } catch (e) {
      if (e instanceof AppError) throw e;
      if (pgError(e).message?.includes('invalid_range')) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_range');
      throw e;
    }
  }

  /**
   * ปฏิทินหน้าจอง: ความว่างของแต่ละวันรับรถ (count วันถัดจาก from) สำหรับการเช่า span วัน รับรถเวลา hour
   * รวมในคำขอเดียว หน้าเว็บจึงไม่ต้องยิงทีละวัน
   */
  @Get('shops/:slug/calendar')
  async calendar(
    @Param('slug') slugRaw: string,
    @Query('from') from: string,
    @Query('span') spanRaw: string,
    @Query('count') countRaw: string,
    @Query('hour') hourRaw: string,
    @Req() req: Request,
  ) {
    // วันที่ต้องเป็นวันจริง (2026-02-30 เดิมผ่าน regex แล้วไปพังที่ฐานข้อมูลเป็น 500)
    if (!z.string().date().safeParse(from).success) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_range');
    const span = Math.min(60, Math.max(1, Number(spanRaw) || 1));
    const count = Math.min(42, Math.max(1, Number(countRaw) || 28));
    const hour = Math.min(22, Math.max(0, Number(hourRaw) || 10));
    // ปฏิทินถามความว่างหลายวันในคำขอเดียว · คิดโควตาตามจำนวนวัน
    await this.limiter.hit('pub-read', clientKey(req), 300, 600, count);
    const slug = await this.enabledSlug(slugRaw);
    const cacheKey = `pubcal:${slug}:${from}:${span}:${count}:${hour}`;
    const cached = await this.valkey.get(cacheKey);
    if (cached) return JSON.parse(cached) as unknown;
    const shop = (await this.db.execute<{ tz: string | null }>(sql`select (pub.shop(${slug}))->>'timezone' as tz`)).rows[0];
    if (!shop?.tz) throw new AppError(HttpStatus.NOT_FOUND, 'shop_not_found');
    // วันที่ในปฏิทิน = วันตามเขตเวลาของร้าน
    const starts = (
      await this.db.execute<{ d: string; s: string }>(sql`
        select gs::date::text as d, (gs::date + make_interval(hours => ${hour}::int))::timestamp at time zone ${shop.tz}::text as s
        from generate_series(${from}::date, ${from}::date + (${count}::int - 1), interval '1 day') gs`)
    ).rows;
    const out: Array<{ date: string; pickupAt: string; past: boolean; types: unknown }> = [];
    for (const row of starts) {
      const start = new Date(row.s);
      const end = new Date(start.getTime() + span * 86_400_000);
      const past = start.getTime() <= Date.now();
      const r = past ? null : await this.db.execute<{ j: { types: unknown } }>(sql`select pub.availability(${slug}, ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz) as j`);
      out.push({ date: row.d, pickupAt: start.toISOString(), past, types: r?.rows[0]?.j?.types ?? [] });
    }
    const result = { timezone: shop.tz, span, hour, days: out };
    await this.valkey.set(cacheKey, JSON.stringify(result), 'EX', CALENDAR_CACHE_SECONDS);
    return result;
  }

  @Post('shops/:slug/bookings')
  @HttpCode(201)
  async create(@Param('slug') slugRaw: string, @Body() body: unknown, @Req() req: Request) {
    const ip = req.ip ?? 'unknown';
    await this.limiter.hit('pub-book-ip', clientKey(req), 10, 3600);
    const slug = await this.enabledSlug(slugRaw);
    const input = parse(bookingBody, body);
    // bot: กรอกช่องที่ซ่อนไว้ หรือส่งเร็วเกินคนพิมพ์ · ตอบเหมือนข้อมูลผิดทั่วไป ไม่บอกเหตุผล
    // (startedAt มาจากเครื่องลูกค้า ปลอมได้ · ด่านจริงคือ rate limit ด้านล่าง)
    if (input.website || Date.now() - input.startedAt < MIN_FORM_MS || input.startedAt > Date.now() + 60_000) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_input');
    }
    if (LINK_RE.test(input.fullName)) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_name');
    const phone = normalizePhone(input.whatsapp);
    if (!phone) throw new AppError(HttpStatus.BAD_REQUEST, 'phone_format');
    // 9 หลักท้าย: +66 81 234 5678 กับ 081 234 5678 นับเป็นเบอร์เดียวกัน
    await this.limiter.hit('pub-book-phone', phone.digits.slice(-9), 5, 86_400);
    await this.limiter.hit('pub-book-shop', slug, SHOP_DAILY_CAP, 86_400);
    const token = newToken();
    const { website: _w, startedAt: _s, ...rest } = input;
    const notes = rest.notes ? rest.notes.replace(LINK_RE_GLOBAL, '').replace(/\s{2,}/g, ' ').trim() : rest.notes;
    const payload = { ...rest, whatsapp: phone.phone, notes: notes || undefined };
    try {
      const r = await this.db.execute<{ booking_id: string; booking_code: string }>(
        sql`select * from pub.create_booking(${slug}, ${JSON.stringify(payload)}::jsonb, ${tokenHash(token)}, ${ip})`,
      );
      const row = r.rows[0]!;
      return { code: row.booking_code, manageUrl: `${this.origin()}/b/${token}`, manageToken: token };
    } catch (e) {
      const m = pgError(e).message ?? '';
      for (const code of ['shop_not_found', 'too_many_days', 'invalid_pickup', 'invalid_item', 'not_available', 'invalid_input']) {
        if (m.includes(code)) {
          throw new AppError(code === 'shop_not_found' ? HttpStatus.NOT_FOUND : code === 'not_available' ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST, code);
        }
      }
      throw e;
    }
  }

  @Get('bookings/:token')
  async view(@Param('token') token: string, @Req() req: Request) {
    await this.limiter.hit('pub-manage', clientKey(req), 60, 600);
    const r = await this.db.execute<{ j: unknown }>(sql`select pub.booking_by_token(${tokenHash(token)}) as j`);
    if (!r.rows[0]?.j) throw new AppError(HttpStatus.NOT_FOUND, 'booking_not_found');
    return r.rows[0].j;
  }

  @Post('bookings/:token/cancel')
  @HttpCode(200)
  async cancel(@Param('token') token: string, @Req() req: Request) {
    await this.limiter.hit('pub-manage', clientKey(req), 60, 600);
    try {
      const r = await this.db.execute<{ j: unknown }>(sql`select pub.cancel_booking(${tokenHash(token)}) as j`);
      return r.rows[0]!.j;
    } catch (e) {
      const m = pgError(e).message ?? '';
      if (m.includes('booking_not_found')) throw new AppError(HttpStatus.NOT_FOUND, 'booking_not_found');
      if (m.includes('booking_not_cancellable')) throw new AppError(HttpStatus.CONFLICT, 'booking_not_cancellable');
      throw e;
    }
  }

  private slug(raw: string) {
    const r = slugParam.safeParse(raw);
    if (!r.success) throw new AppError(HttpStatus.NOT_FOUND, 'shop_not_found');
    return r.data;
  }

  /** ร้านต้องเปิดหน้าจองเอง · ปิดอยู่ตอบเหมือนไม่มีร้านนี้ (ไม่ให้เดาได้ว่ามีร้าน) */
  private async enabledSlug(raw: string) {
    const slug = this.slug(raw);
    const r = await this.db.execute<{ ok: boolean }>(sql`select pub.booking_enabled(${slug}) as ok`);
    if (!r.rows[0]?.ok) throw new AppError(HttpStatus.NOT_FOUND, 'shop_not_found');
    return slug;
  }

  private origin() {
    return this.config.BOOKING_ORIGIN ?? this.config.WEB_ORIGIN;
  }
}
