import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { VALKEY } from '../infra.js';
import { AppError } from './http.js';

/**
 * จำกัดจำนวนครั้งแบบ fixed window เก็บใน Valkey
 * ใช้ร่วมกันทุกเครื่องหลัง load balancer (เก็บในหน่วยความจำของเครื่องเดียวจะนับไม่ครบเมื่อมีหลายเครื่อง)
 */
@Injectable()
export class RateLimiter {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  /** cost = จำนวนครั้งที่คำขอนี้กินโควตา (คำขอที่หนักกว่า เช่น ปฏิทิน 28 วัน คิดตามจำนวนวัน) */
  async hit(bucket: string, key: string, limit: number, windowSeconds: number, cost = 1): Promise<void> {
    const k = `rl:${bucket}:${key}`;
    const step = Math.max(1, Math.floor(cost));
    // ตั้งอายุพร้อมสร้าง key (NX) แล้วค่อยนับ · ถ้าแยกสองคำสั่งแล้วคำสั่งที่สองพลาด ตัวนับจะไม่มีวันหมดอายุ
    const [, incr] = (await this.valkey.multi().set(k, 0, 'EX', windowSeconds, 'NX').incrby(k, step).exec()) ?? [];
    const n = Number(incr?.[1] ?? 0);
    if (n > limit) {
      const ttl = await this.valkey.ttl(k);
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', { retryAfterSeconds: Math.max(ttl, 1) });
    }
  }
}

/**
 * key สำหรับนับต่อผู้เรียก (หน้าสาธารณะ)
 * - IPv4 / IPv4-mapped (::ffff:1.2.3.4) → ที่อยู่ v4
 * - IPv6 → prefix /64 (ผู้ใช้หนึ่งรายได้ทั้ง /64 · นับต่อที่อยู่เดียวจะหมุนที่อยู่หนีได้)
 */
export function clientKey(req: Pick<Request, 'ip'>): string {
  const ip = (req.ip ?? '').trim();
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;
  return `${ipv6Prefix64(ip)}::/64`;
}

/** 4 กลุ่มแรกของ IPv6 (ขยาย :: ก่อน) */
export function ipv6Prefix64(ip: string): string {
  const addr = ip.split('%')[0]!.toLowerCase();
  const compressed = addr.includes('::');
  const [head = '', tail = ''] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = compressed && tail ? tail.split(':') : [];
  const groups = compressed ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups
    .slice(0, 4)
    .map((g) => (g || '0').replace(/^0+(?=.)/, ''))
    .join(':');
}
