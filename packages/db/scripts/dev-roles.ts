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
  const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'rental_api'`,
  );
  if (rows[0]) {
    // บัญชีที่ไม่ใช่ superuser (rental_owner) แก้ SUPERUSER/BYPASSRLS ไม่ได้ แม้จะเป็นการปิด
    // จึงตั้งแค่รหัส แล้วตรวจว่า role ยังอยู่ใต้ RLS · ถ้าไม่ใช่ ให้หยุด (ผู้ดูแลต้องแก้ด้วย superuser)
    if (rows[0].rolsuper || rows[0].rolbypassrls) throw new Error('rental_api must be NOSUPERUSER NOBYPASSRLS (fix with a superuser)');
    await client.query(`ALTER ROLE rental_api WITH LOGIN PASSWORD ${quoted}`);
  } else {
    await client.query(`CREATE ROLE rental_api WITH LOGIN PASSWORD ${quoted} NOSUPERUSER NOBYPASSRLS IN ROLE rental_app`);
  }
  await client.query(`GRANT rental_app TO rental_api`);
  console.log('role rental_api ready');
} finally {
  await client.end();
}
