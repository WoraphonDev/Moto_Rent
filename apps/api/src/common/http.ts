import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import type { z } from 'zod';

/** error ที่หน้าเว็บอ่าน code แล้วแสดงข้อความภาษาของผู้ใช้เอง */
export class AppError extends HttpException {
  constructor(status: HttpStatus, code: string, extra: Record<string, unknown> = {}) {
    super({ error: code, ...extra }, status);
  }
}

export function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new BadRequestException({
      error: 'invalid_input',
      fields: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

/** ดึง error ของ Postgres ที่ drizzle ห่อไว้ใน cause */
export function pgError(e: unknown): { code?: string; message?: string; constraint?: string } {
  const err = e as { cause?: { code?: string; message?: string; constraint?: string }; code?: string; message?: string };
  return err.cause ?? err;
}
