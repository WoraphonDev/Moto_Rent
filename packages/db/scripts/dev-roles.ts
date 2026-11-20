// สร้างบัญชีเข้าฐานข้อมูลของ API (LOGIN) ให้เป็นสมาชิกของ rental_app · รหัสมาจาก env ไม่อยู่ใน migration
// production ตั้งรหัสจริงผ่าน secret ของเซิร์ฟเวอร์แล้วรันสคริปต์นี้ครั้งเดียว
import pg from 'pg';

const url = process.env.DATABASE_OWNER_URL;
const password = process.env.RENTAL_API_DB_PASSWORD;
if (!url || !password) throw new Error('DATABASE_OWNER_URL and RENTAL_API_DB_PASSWORD are required');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const quoted = client.escapeLiteral(password);
  const { rowCount } = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'rental_api'`);
  if (rowCount) {
    await client.query(`ALTER ROLE rental_api WITH LOGIN PASSWORD ${quoted} NOSUPERUSER NOBYPASSRLS`);
  } else {
    await client.query(`CREATE ROLE rental_api WITH LOGIN PASSWORD ${quoted} NOSUPERUSER NOBYPASSRLS IN ROLE rental_app`);
  }
  await client.query(`GRANT rental_app TO rental_api`);
  console.log('role rental_api ready');
} finally {
  await client.end();
}
