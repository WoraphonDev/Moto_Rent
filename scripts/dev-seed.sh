#!/usr/bin/env bash
# ร้านทดลองสำหรับพัฒนาในเครื่องเท่านั้น (ห้ามใช้รหัสเหล่านี้ที่อื่น)
# เจ้าของ: dev.owner / Dev-owner-2026 · ร้าน: dev-shop
set -euo pipefail
API=${API:-http://127.0.0.1:4100}
curl -s -X POST "$API/v1/auth/signup" -H 'content-type: application/json' \
  -d '{"shopName":"ร้านทดลอง เกาะเต่า","slug":"dev-shop","username":"dev.owner","displayName":"เจ้าของ","password":"Dev-owner-2026"}'
echo

# พนักงานทดลอง (สร้างผ่านลิงก์เชิญในเครื่อง): dev.nok / Dev-nok-sunrise-77
