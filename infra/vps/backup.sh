#!/usr/bin/env bash
# สำรองฐานข้อมูลรายวัน (cron 03:30) · เก็บ 14 วันล่าสุด · รูป: อยู่ R2 (ไม่สำรองที่นี่) หรือบนดิสก์ช่วงทดลอง (สำรองด้วย)
set -euo pipefail
cd "$(dirname "$0")"
out="backups/rental-$(date +%Y%m%d-%H%M).sql.gz"
docker compose exec -T postgres pg_dump -U postgres -d rental --no-owner | gzip -6 > "$out.tmp"
mv "$out.tmp" "$out"
chmod 600 "$out"
ls -1t backups/rental-*.sql.gz | tail -n +15 | xargs -r rm -f
# ยังไม่มี R2 = รูปอยู่บนดิสก์ของเครื่อง · สำรองด้วย (เก็บ 7 วัน)
if grep -q '^ALLOW_LOCAL_STORAGE=true' .env; then
  up="backups/uploads-$(date +%Y%m%d-%H%M).tar.gz"
  docker compose exec -T api tar -C /data -cz uploads > "$up.tmp" && mv "$up.tmp" "$up" && chmod 600 "$up"
  ls -1t backups/uploads-*.tar.gz | tail -n +8 | xargs -r rm -f
fi
echo "$(date -Is) ok $out $(du -h "$out" | cut -f1)"
