import { randomBytes } from 'node:crypto';

export type ImageType = { contentType: 'image/jpeg' | 'image/png' | 'image/webp'; ext: 'jpg' | 'png' | 'webp' };

/**
 * ตรวจชนิดรูปจาก byte แรกของไฟล์ (magic bytes) ไม่เชื่อ content-type ที่เครื่องส่งมา
 * รับเฉพาะ JPEG / PNG / WebP · ไฟล์อื่น (PDF, SVG, HTML ที่แอบตั้งนามสกุลเป็นรูป) ถูกปฏิเสธ
 */
export function sniffImage(buf: Buffer): ImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { contentType: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', ext: 'png' };
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { contentType: 'image/webp', ext: 'webp' };
  }
  return null;
}

/** uuid v7 (เรียงตามเวลา) สำหรับชื่อไฟล์ในที่เก็บ */
export function uuidv7(): string {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_SIGNATURE_BYTES = 1024 * 1024;

/** ไฟล์จาก multer (เก็บในหน่วยความจำ) */
export interface UploadedFileLike {
  buffer: Buffer;
  size: number;
  originalname?: string;
}
