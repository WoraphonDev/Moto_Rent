#!/usr/bin/env bash
# deploy ระบบร้านเช่าขึ้น VPS (เครื่องเดียวกับ Friday) · รันจากรากของ repo บน Mac:
#   infra/vps/deploy.sh
#   VPS_HOST=root@<ip> VPS_KEY=~/.ssh/<key> APP_HOST=<host> infra/vps/deploy.sh
# VPS มี RAM 2 GB ไม่พอ build Next.js → build image linux/amd64 บน Mac แล้วส่งด้วย docker save | ssh docker load
# ไม่ต้องมี registry และไม่ต้องเก็บ token บนเครื่อง
set -euo pipefail

VPS_HOST="${VPS_HOST:-root@45.141.26.85}"
VPS_KEY="${VPS_KEY:-$HOME/.ssh/friday_vps}"
APP_HOST="${APP_HOST:-rent.45-141-26-85.sslip.io}"
APP_DIR=/opt/moto
FRIDAY_DIR=/opt/friday
TAG="$(git rev-parse --short HEAD)"
SSH=(ssh -i "$VPS_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$VPS_HOST")

if [ -n "$(git status --porcelain)" ]; then
  echo "มีไฟล์ที่ยังไม่ commit · deploy เฉพาะโค้ดที่ commit แล้ว (TAG=$TAG)" >&2
  exit 1
fi

echo "== build image linux/amd64 (TAG=$TAG)"
docker buildx build --platform linux/amd64 -f infra/docker/api.Dockerfile -t "moto-api:$TAG" --load .
docker buildx build --platform linux/amd64 -f infra/docker/web.Dockerfile -t "moto-web:$TAG" --load .

echo "== ส่ง image ขึ้นเครื่อง"
docker save "moto-api:$TAG" "moto-web:$TAG" | gzip -1 | "${SSH[@]}" 'gunzip | docker load'

echo "== ส่งไฟล์ตั้งค่า"
"${SSH[@]}" "mkdir -p $APP_DIR/backups && chmod 700 $APP_DIR $APP_DIR/backups"
scp -i "$VPS_KEY" -o IdentitiesOnly=yes -q infra/vps/compose.yml infra/prod/postgres-init.sh infra/vps/backup.sh infra/vps/set-r2.sh "$VPS_HOST:$APP_DIR/"
sed "s/__APP_HOST__/$APP_HOST/" infra/vps/moto.caddy | "${SSH[@]}" "mkdir -p $FRIDAY_DIR/sites && cat > $FRIDAY_DIR/sites/moto.caddy"

echo "== เตรียม .env (สุ่มรหัสบนเครื่อง ครั้งแรกเท่านั้น · ไม่แสดงบนจอ)"
"${SSH[@]}" APP_DIR="$APP_DIR" APP_HOST="$APP_HOST" TAG="$TAG" 'bash -s' <<'REMOTE'
set -euo pipefail
cd "$APP_DIR"
chmod 700 backup.sh set-r2.sh
# postgres (ใน container ไม่ใช่ root) ต้องอ่านได้ตอนสร้างฐานข้อมูลครั้งแรก · ไฟล์นี้ไม่มีรหัส (รหัสมาจาก env)
chmod 644 postgres-init.sh
touch .env && chmod 600 .env
put() { grep -q "^$1=" .env || echo "$1=$2" >> .env; }
rnd() { openssl rand -hex 24; }
put APP_HOST "$APP_HOST"
put POSTGRES_SUPERUSER_PASSWORD "$(rnd)"
put RENTAL_OWNER_PASSWORD "$(rnd)"
put RENTAL_API_DB_PASSWORD "$(rnd)"
put VALKEY_PASSWORD "$(rnd)"
put TOTP_ENC_KEY "$(openssl rand -base64 32)"
sed -i "s/^TAG=.*//" .env && echo "TAG=$TAG" >> .env && sed -i '/^$/d' .env
sed -i '/^ALLOW_LOCAL_STORAGE=/d' .env
if grep -q '^S3_BUCKET=.' .env; then
  echo "ALLOW_LOCAL_STORAGE=false" >> .env
else
  # ช่วงทดลอง: ยังไม่มี R2 → เก็บรูปบนดิสก์ของเครื่อง (สำรองทุกคืนใน backup.sh) · ตั้ง R2 ทีหลังด้วย set-r2.sh
  echo "ALLOW_LOCAL_STORAGE=true" >> .env
  echo "คำเตือน: ยังไม่ได้ตั้ง R2 · เก็บรูปบนดิสก์ของ VPS ชั่วคราว (ssh -t <vps> $APP_DIR/set-r2.sh เมื่อพร้อม)" >&2
fi
docker network inspect friday_default >/dev/null
docker compose up -d postgres valkey
docker compose run --rm migrate
# volume รูป (ใช้ตอนยังไม่มี R2) ให้ผู้ใช้ node ใน container เขียนได้
docker compose run --rm --no-deps --user 0 --entrypoint sh api -c 'chown node:node /data/uploads' >/dev/null
docker compose up -d --remove-orphans api web
for i in $(seq 1 30); do
  bad="$(docker compose ps --format '{{.Service}} {{.Health}}' | awk '$2!="healthy" && $1!="migrate"{print $1}')"
  [ -z "$bad" ] && break
  sleep 3
done
docker compose ps
[ -z "${bad:-}" ] || { echo "service ยังไม่ healthy: $bad" >&2; exit 1; }
# Caddy ของ Friday โหลด site ของเราใหม่ (ไม่ตัดการเชื่อมต่อของ Friday)
docker exec friday-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
# สำรองฐานข้อมูลทุกวัน 03:30
( crontab -l 2>/dev/null | grep -v "$APP_DIR/backup.sh"; echo "30 3 * * * $APP_DIR/backup.sh >> $APP_DIR/backups/backup.log 2>&1" ) | crontab -
REMOTE

echo "== ตรวจจากภายนอก"
curl -fsS -o /dev/null -w "web %{http_code}\n" "https://$APP_HOST/login"
curl -fsS -o /dev/null -w "api %{http_code}\n" "https://$APP_HOST/api/v1/public/shops/__none__" || true
echo "เสร็จ · https://$APP_HOST"
