import { ApiError, type PaymentMethod, type Rental } from './api';

/** รูป/เอกสารจาก API (ตัวไฟล์เปิดที่ /api/v1/media/:id/content) */
export interface Media {
  id: string;
  kind: 'vehicle_photo' | 'document' | 'signature' | 'maintenance_receipt';
  slot: string | null;
  stage: 'checkout' | 'return' | null;
  rentalId: string | null;
  customerId: string | null;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  deleteAfter: string | null;
  by?: string;
}

/** สัญญาพร้อมสถานะลายเซ็น (API ส่งมากับ /v1/rentals/:id อยู่แล้ว) */
export type RentalWithSign = Rental & { signedAt: string | null; signerName: string | null };

export interface DayClose {
  id: string;
  date: string;
  expectedCash: number;
  countedCash: number;
  difference: number;
  expectedOther: number;
  note: string | null;
  closedBy: string;
  closedAt: string;
}

export interface DayCloseSummary {
  date: string;
  today: string;
  byMethod: Array<{ method: PaymentMethod; total: number; count: number }>;
  expectedCash: number;
  expectedOther: number;
  closed: DayClose | null;
  recent: DayClose[];
}

export const mediaUrl = (id: string) => `/api/v1/media/${encodeURIComponent(id)}/content`;

/**
 * ส่งไฟล์ (multipart) พร้อมความคืบหน้า · ใช้ XHR เพราะ fetch ยังรายงานความคืบหน้าตอนอัปโหลดไม่ได้
 * ต้องมี header x-requested-with (กฎกัน CSRF ของ API สำหรับ multipart)
 */
export function uploadForm<T>(path: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('x-requested-with', 'fetch');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error'));
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = xhr.responseText ? (JSON.parse(xhr.responseText) as Record<string, unknown>) : {};
      } catch {
        /* ไม่ใช่ JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as T);
      const { error, ...rest } = data as { error?: string };
      reject(new ApiError(xhr.status, typeof error === 'string' ? error : `http_${xhr.status}`, rest));
    };
    xhr.send(form);
  });
}

/**
 * ย่อรูปที่เครื่องก่อนส่ง (ด้านยาวไม่เกิน maxSide · JPEG) · ประหยัดเน็ตบนเกาะและที่เก็บ
 * หมุนตาม EXIF ให้ถูกด้าน · ไฟล์ที่เบราว์เซอร์เปิดไม่ได้ (เช่น HEIC บางเครื่อง) ถือว่าผิดพลาด
 */
export async function resizeImage(file: Blob, maxSide = 1600, quality = 0.8): Promise<Blob> {
  let source: ImageBitmap | HTMLImageElement;
  let w: number;
  let h: number;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    source = bmp;
    w = bmp.width;
    h = bmp.height;
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((ok, fail) => {
        img.onload = () => ok();
        img.onerror = () => fail(new Error('decode'));
        img.src = url;
      });
      source = img;
      w = img.naturalWidth;
      h = img.naturalHeight;
    } catch {
      throw new ApiError(0, 'image_unreadable');
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ApiError(0, 'image_unreadable');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if ('close' in source) source.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new ApiError(0, 'image_unreadable'))), 'image/jpeg', quality),
  );
}
