#!/usr/bin/env bash
# ร้านทดลองสำหรับพัฒนาในเครื่องเท่านั้น (ห้ามใช้รหัสเหล่านี้ที่อื่น)
# เจ้าของ: dev.owner / Dev-owner-2026 · ร้าน: dev-shop
set -euo pipefail
API=${API:-http://127.0.0.1:4100}
# เก็บ cookie ของเครื่องที่สมัคร (อนุมัติแล้ว) ไว้ให้ dev-seed-fleet.py ใช้ต่อ
# เจ้าของร้านเข้าจากเครื่องใหม่ไม่ได้จนกว่าจะเปิดยืนยันตัวตน 2 ชั้น
mkdir -p .data
curl -s -c .data/dev-seed.cookies -X POST "$API/v1/auth/signup" -H 'content-type: application/json' \
  -d '{"shopName":"ร้านทดลอง เกาะเต่า","slug":"dev-shop","username":"dev.owner","displayName":"เจ้าของ","password":"Dev-owner-2026"}'
echo

# พนักงานทดลอง (สร้างผ่านลิงก์เชิญในเครื่อง): dev.nok / Dev-nok-sunrise-77
