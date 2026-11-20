// รัน migration ด้วยบัญชีเจ้าของ schema (ไม่ใช่บัญชีของ API)
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('DATABASE_OWNER_URL is required');

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle({ client: pool }), {
    migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
  });
  console.log('migrations applied');
} finally {
  await pool.end();
}
