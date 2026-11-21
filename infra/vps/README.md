# VPS ช่วงทดลอง (เครื่องเดียวกับ Friday)

- ระบบอยู่ที่ `/opt/moto` (docker compose project `moto`) · ไม่ยุ่งกับ container ของ Friday
- HTTPS ผ่าน Caddy ของ Friday: site ของเราอยู่ที่ `/opt/friday/sites/moto.caddy` (Friday import ไว้ · PR Friday_Manage#276)
- web/api เข้า network `friday_default` ด้วยชื่อ `moto-web` / `moto-api` · Postgres/Valkey อยู่ใน network ภายในเท่านั้น
- จำกัดหน่วยความจำทุก service (เครื่อง 2 GB ใช้ร่วมกับ Friday)

## ครั้งแรก
1. สร้าง Cloudflare R2 bucket + API token (Object Read & Write เฉพาะ bucket นั้น)
2. `infra/vps/deploy.sh` (ส่ง image + สุ่มรหัสใน `.env` บนเครื่อง · หยุดรอ R2)
3. `ssh -t -i ~/.ssh/friday_vps root@45.141.26.85 /opt/moto/set-r2.sh` (ใส่ค่า R2 บนเครื่อง ไม่ผ่านแชต)
4. `infra/vps/deploy.sh` อีกครั้ง → https://rent.45-141-26-85.sslip.io

## ทุกครั้งที่อัปเดต
commit แล้ว `infra/vps/deploy.sh` (build linux/amd64 บน Mac → `docker save | ssh docker load` → migrate → up)

## สำรองข้อมูล
cron 03:30 ทุกวัน → `/opt/moto/backups` เก็บ 14 วัน · รูปอยู่ที่ R2
ห้ามเปลี่ยน `TOTP_ENC_KEY` ใน `.env` (เปลี่ยน = เจ้าของทุกร้านต้องตั้ง 2 ชั้นใหม่) · สำรอง `.env` เก็บไว้ที่ปลอดภัย
