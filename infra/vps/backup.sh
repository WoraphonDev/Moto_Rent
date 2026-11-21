#!/usr/bin/env bash
# สำรองฐานข้อมูลรายวัน (cron 03:30) · เก็บ 14 วันล่าสุด · ไฟล์รูปอยู่ที่ R2 (ไม่ได้สำรองที่นี่)
set -euo pipefail
cd "$(dirname "$0")"
out="backups/rental-$(date +%Y%m%d-%H%M).sql.gz"
docker compose exec -T postgres pg_dump -U postgres -d rental --no-owner | gzip -6 > "$out.tmp"
mv "$out.tmp" "$out"
chmod 600 "$out"
ls -1t backups/rental-*.sql.gz | tail -n +15 | xargs -r rm -f
echo "$(date -Is) ok $out $(du -h "$out" | cut -f1)"
