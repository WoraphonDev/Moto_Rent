#!/bin/sh
# รันครั้งเดียวตอนสร้างฐานข้อมูลใหม่ (docker-entrypoint-initdb.d)
# superuser (POSTGRES_USER) ใช้ตั้งเครื่องเท่านั้น · migration ใช้ rental_owner ที่ไม่ใช่ superuser
# (CREATEROLE เพื่อสร้าง role ของ API) · API ใช้ rental_api ที่อยู่ใต้ RLS เสมอ
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$RENTAL_OWNER_PASSWORD" <<'SQL'
CREATE ROLE rental_owner LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE PASSWORD :'owner_pw';
ALTER DATABASE rental OWNER TO rental_owner;
ALTER SCHEMA public OWNER TO rental_owner;
SQL
