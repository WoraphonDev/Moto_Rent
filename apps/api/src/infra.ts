import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@rental/db';
import { Redis } from 'ioredis';
import { CONFIG, loadConfig, type Config } from './config.js';

export const DB = Symbol('DB');
export const VALKEY = Symbol('VALKEY');

/** ทรัพยากรที่ใช้ร่วมทั้งแอป · แอปไม่เก็บ state ในเครื่อง (session/rate limit อยู่ใน Postgres/Valkey) จึงรันกี่เครื่องก็ได้ */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    { provide: DB, inject: [CONFIG], useFactory: (c: Config) => createDb(c.DATABASE_APP_URL) },
    {
      provide: VALKEY,
      inject: [CONFIG],
      useFactory: (c: Config) => new Redis(c.VALKEY_URL, { maxRetriesPerRequest: 2, lazyConnect: false }),
    },
  ],
  exports: [CONFIG, DB, VALKEY],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  async onApplicationShutdown() {
    await Promise.allSettled([this.db.$client.end(), this.valkey.quit()]);
  }
}
