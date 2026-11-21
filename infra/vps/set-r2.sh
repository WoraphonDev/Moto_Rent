#!/usr/bin/env bash
# ตั้งที่เก็บรูป (Cloudflare R2) บนเซิร์ฟเวอร์ · ถามค่าในเครื่อง ไม่ผ่านแชต และไม่แสดงกุญแจลับบนจอ
#   ssh -t -i ~/.ssh/friday_vps root@<vps> /opt/moto/set-r2.sh
set -euo pipefail
cd "$(dirname "$0")"
touch .env && chmod 600 .env
read -r -p "R2 bucket name: " bucket
read -r -p "R2 endpoint (https://<account-id>.r2.cloudflarestorage.com): " endpoint
read -r -p "Access Key ID: " key
read -r -s -p "Secret Access Key (ไม่แสดง): " secret
echo
case "$endpoint" in https://*) ;; *) echo "endpoint ต้องขึ้นต้นด้วย https://" >&2; exit 1 ;; esac
[ -n "$bucket" ] && [ -n "$key" ] && [ -n "$secret" ] || { echo "ใส่ให้ครบ" >&2; exit 1; }
cp .env ".env.bak-$(date +%Y%m%d-%H%M%S)" && chmod 600 .env.bak-*
sed -i '/^S3_BUCKET=/d;/^S3_ENDPOINT=/d;/^S3_REGION=/d;/^S3_ACCESS_KEY=/d;/^S3_SECRET_KEY=/d' .env
{
  echo "S3_BUCKET=$bucket"
  echo "S3_ENDPOINT=$endpoint"
  echo "S3_REGION=auto"
  echo "S3_ACCESS_KEY=$key"
  echo "S3_SECRET_KEY=$secret"
} >> .env
echo "บันทึกแล้ว · deploy อีกครั้ง (หรือ docker compose up -d api) ให้ API ใช้ค่าใหม่"
