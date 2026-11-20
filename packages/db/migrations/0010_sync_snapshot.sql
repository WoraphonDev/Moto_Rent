-- ทำให้ snapshot ของ drizzle รู้จักคอลัมน์ที่ migration 0009 เพิ่มด้วย SQL แล้ว (IF NOT EXISTS = ไม่ทำอะไรซ้ำ)
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "public_booking_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "customer_mode_rental_id" uuid;
