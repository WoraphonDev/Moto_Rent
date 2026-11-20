import { HttpStatus } from '@nestjs/common';
import { AppError, pgError } from './http.js';

/** แปลง error จากกฎในฐานข้อมูลเป็น error ที่หน้าเว็บเข้าใจ · error อื่นโยนต่อตามเดิม */
export function mapDbError(e: unknown): never {
  const pe = pgError(e);
  const msg = pe.message ?? '';
  if (pe.code === '23505') {
    if (msg.includes('rental_items_one_active_per_asset')) throw new AppError(HttpStatus.CONFLICT, 'asset_unavailable');
    if (msg.includes('assets_org_code_key')) throw new AppError(HttpStatus.CONFLICT, 'asset_code_taken');
    if (msg.includes('asset_variants_type_label_key')) throw new AppError(HttpStatus.CONFLICT, 'variant_label_taken');
    if (msg.includes('rentals_pkey')) throw new AppError(HttpStatus.CONFLICT, 'rental_exists');
    if (msg.includes('day_closes_org_date_key')) throw new AppError(HttpStatus.CONFLICT, 'day_already_closed');
    if (msg.includes('payments_client_key')) throw new AppError(HttpStatus.CONFLICT, 'payment_duplicate');
    throw new AppError(HttpStatus.CONFLICT, 'duplicate');
  }
  if (pe.code === '42501') {
    for (const code of ['discount_over_limit', 'owner_only', 'forbidden_field']) {
      if (msg.includes(code)) throw new AppError(HttpStatus.FORBIDDEN, code);
    }
    throw new AppError(HttpStatus.FORBIDDEN, 'forbidden');
  }
  if (pe.code === '23514') {
    for (const code of ['bill_closed', 'rental_closed', 'day_closed']) if (msg.includes(code)) throw new AppError(HttpStatus.CONFLICT, code);
    throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_input');
  }
  // สองคำขอรอล็อกกันเอง (deadlock) หรือชนกันใน serializable · ให้เครื่องลองส่งใหม่
  if (pe.code === '40P01' || pe.code === '40001') throw new AppError(HttpStatus.CONFLICT, 'conflict_retry');
  if (pe.code === '23503' && msg.includes('cross_org_reference')) throw new AppError(HttpStatus.NOT_FOUND, 'not_found');
  throw e;
}

export async function dbCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) throw e;
    return mapDbError(e);
  }
}
