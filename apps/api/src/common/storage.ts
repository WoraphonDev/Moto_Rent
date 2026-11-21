import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Global, Inject, Module } from '@nestjs/common';
import { CONFIG, type Config } from '../config.js';

/**
 * ที่เก็บไฟล์ (รูปรถ เอกสาร ลายเซ็น ใบเสร็จค่าซ่อม)
 * - production: S3/R2 · แอปทุกเครื่องเห็นไฟล์ชุดเดียวกัน (ไม่มี state ในเครื่อง)
 * - พัฒนา/เทสต์: โฟลเดอร์ในเครื่อง
 * ไฟล์ทุกไฟล์ส่งผ่าน API (ไม่ออกลิงก์ตรง) เพื่อตรวจสิทธิ์และบันทึกการเปิดดูเอกสารทุกครั้ง
 */
export interface Storage {
  readonly kind: 's3' | 'local';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Readable; size?: number }>;
  remove(key: string): Promise<void>;
}

export const STORAGE = Symbol('STORAGE');

class S3Storage implements Storage {
  readonly kind = 's3' as const;
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async get(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return { body: r.Body as Readable, size: r.ContentLength };
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

class LocalStorage implements Storage {
  readonly kind = 'local' as const;
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  /** กัน path traversal: key ต้องอยู่ใต้ root เสมอ */
  private path(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return p;
  }
  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async get(key: string) {
    const p = this.path(key);
    const s = await stat(p);
    return { body: createReadStream(p), size: s.size };
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
}

export function createStorage(c: Config): Storage {
  if (c.S3_BUCKET) {
    const client = new S3Client({
      region: c.S3_REGION,
      endpoint: c.S3_ENDPOINT,
      forcePathStyle: !!c.S3_ENDPOINT,
      credentials: c.S3_ACCESS_KEY && c.S3_SECRET_KEY ? { accessKeyId: c.S3_ACCESS_KEY, secretAccessKey: c.S3_SECRET_KEY } : undefined,
    });
    return new S3Storage(client, c.S3_BUCKET);
  }
  if (process.env.NODE_ENV === 'production') {
    if (!c.ALLOW_LOCAL_STORAGE) throw new Error('S3_BUCKET is required in production (files must be shared by every server)');
    // ช่วงทดลองบน VPS เครื่องเดียว (ตั้งใจเปิดเอง) · เตือนทุกครั้งที่เริ่ม
    console.warn(`[storage] production is using LOCAL disk at ${c.STORAGE_DIR} (ALLOW_LOCAL_STORAGE=true) · single API instance only, move to S3/R2 before scaling`);
  }
  return new LocalStorage(c.STORAGE_DIR);
}

@Global()
@Module({
  providers: [{ provide: STORAGE, inject: [CONFIG], useFactory: (c: Config) => createStorage(c) }],
  exports: [STORAGE],
})
export class StorageModule {
  constructor(@Inject(STORAGE) readonly storage: Storage) {}
}
