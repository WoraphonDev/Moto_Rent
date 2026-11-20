# Rental platform

ระบบบริหารร้านเช่า (SaaS หลายร้าน) · ร้านต้นแบบคือร้านเช่ารถบนเกาะเต่า · ต่อไปจะเชื่อม Marketplace (project แยก)
อ่าน `docs/adr/0001-platform-foundation.md` ก่อนแก้โครงสร้าง

## คุยกับเจ้าของ project

- ตอบเป็นภาษาไทยเสมอ
- หน้าจอใหม่หรือหน้าจอที่จะแก้ ต้องทำ mock + story ให้ดูก่อนเขียนโค้ด (canvas: https://claude.ai/artifact/DvmL3tYsz4ZqouE75uF7VL)
- สไตล์ UI = รวม Friday + MIX (พื้นครีม #FBF5EC · ปุ่มหลักเขียวหัวเป็ด #0F4C4A · เลือก/อยู่ = ส้ม #E2603B · การ์ดมุม 12 ปุ่ม 8 ป้าย 6)

## คำสั่ง

```sh
cp .env.example .env    # ครั้งแรก
pnpm install
pnpm db:setup           # Postgres + Valkey (Docker) + migration + role ของ API
pnpm test               # core (หน่วย) + db (RLS) + api (e2e กับฐานข้อมูลจริง)
pnpm typecheck
pnpm api:dev            # API ที่ :4100
```

แก้ schema: แก้ `packages/db/src/schema/*` → `pnpm db:generate` → เพิ่ม RLS/สิทธิ์ใน migration แบบ `--custom` → `pnpm db:migrate`
ห้ามแก้ migration ที่รันไปแล้ว ให้เพิ่มไฟล์ใหม่

## กติกาที่ต้องรักษา

- ตารางข้อมูลร้านทุกตาราง: มี `org_id` + `ENABLE ROW LEVEL SECURITY` + policy ที่ใช้ `app.org_id()` + เทสต์ข้ามร้านใน `packages/db/test`
- API คุยกับฐานข้อมูลผ่าน `withTenant(db, auth, tx => ...)` เท่านั้น · งานก่อนรู้ตัวตนใช้ฟังก์ชัน `auth.*`
- การเปลี่ยนแปลงที่สำคัญ (เงิน ส่วนลด ยกเลิก สิทธิ์ เครื่อง) เรียก `audit(tx, ...)` ในธุรกรรมเดียวกัน
- เงินเป็นจำนวนเต็มหน่วยย่อย (สตางค์) เสมอ · กฎราคา/ของว่างอยู่ใน `packages/core` (ฟังก์ชันล้วน มีเทสต์)
- แอปห้ามเก็บ state ในเครื่อง (ไฟล์ → S3/R2, session → Postgres, rate limit/ตั๋วชั่วคราว → Valkey)
- import ภายใน `apps/api` ลงท้าย `.js` · ภายใน `packages/*` ลงท้าย `.ts` (Node อ่าน TypeScript ตรง)
- error ที่ส่งให้หน้าเว็บเป็น `{ error: 'code' }` ภาษาอังกฤษ · หน้าเว็บแปลเป็นข้อความเอง
