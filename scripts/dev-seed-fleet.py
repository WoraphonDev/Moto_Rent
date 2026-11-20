#!/usr/bin/env python3
"""ใส่ข้อมูลร้านทดลองให้เหมือนร้านเกาะเต่า (ในเครื่องเท่านั้น) · รันหลัง scripts/dev-seed.sh
ราคาชุดดำน้ำ ฿100/วัน เป็นค่าทดลอง ยังไม่ใช่ราคาจริงของร้าน
"""
import datetime as dt
import http.cookiejar
import json
import os
import urllib.request
import uuid

API = os.environ.get("API", "http://127.0.0.1:4100")
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json", "x-requested-with": "seed"})
    try:
        with opener.open(req) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} -> {e.code} {e.read().decode()}")


def iso(d):
    return d.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


call("POST", "/v1/auth/login", {"identifier": "dev.owner", "password": "Dev-owner-2026", "deviceName": "สคริปต์ seed"})
existing = call("GET", "/v1/asset-types")
if any(t["name"] == "Honda Click 125" for t in existing):
    raise SystemExit("มีข้อมูลอยู่แล้ว · ข้าม")

click = call("POST", "/v1/asset-types", {"name": "Honda Click 125", "tracking": "unit", "codePrefix": "C-", "pricePerDay": 25000})
atv = call("POST", "/v1/asset-types", {"name": "ATV", "tracking": "unit", "codePrefix": "A-", "pricePerDay": 70000})
gear = call("POST", "/v1/asset-types", {"name": "ชุดดำน้ำ", "tracking": "quantity", "pricePerDay": 10000})
for size, qty in [("S", 8), ("M", 12), ("L", 12), ("XL", 8)]:
    call("POST", f"/v1/asset-types/{gear['id']}/variants", {"label": size, "quantity": qty})

colors = ["ขาว", "ดำ", "แดง", "ขาว", "ฟ้า", "ดำ", "ขาว", "แดง", "เทา", "ขาว", "ดำ", "ขาว"]
units = {}
for i, c in enumerate(colors):
    a = call("POST", "/v1/assets", {"assetTypeId": click["id"], "model": "Click 125", "color": c, "plate": f"กข {1201 + i}", "odometer": 8000 + i * 731})
    units[a["code"]] = a["id"]
for i in range(4):
    a = call("POST", "/v1/assets", {"assetTypeId": atv["id"], "model": "ATV 150", "color": "เขียว", "odometer": 2500 + i * 410})
    units[a["code"]] = a["id"]
call("PATCH", f"/v1/assets/{units['C-10']}", {"status": "maintenance", "notes": "เปลี่ยนน้ำมันเครื่อง"})

today = dt.date.today()
now = dt.datetime.now(dt.timezone.utc)
people = {
    "emma": {"fullName": "Emma Larsen", "nationality": "DK", "hotelRoom": "204", "phone": "+4520123456", "checkoutDate": str(today + dt.timedelta(days=4))},
    "lukas": {"fullName": "Lukas Becker", "nationality": "DE", "hotelRoom": "112", "phone": "+4915112345678", "checkoutDate": str(today + dt.timedelta(days=2))},
    "sophie": {"fullName": "Sophie Martin", "nationality": "FR", "hotelRoom": "305", "phone": "+33612345678", "checkoutDate": str(today)},
    "noa": {"fullName": "Noa Cohen", "nationality": "IL", "hotelRoom": "118", "checkoutDate": str(today)},
    "james": {"fullName": "James Walker", "nationality": "GB", "phone": "+447700900123"},
    "mia": {"fullName": "Mia Rossi", "nationality": "IT", "hotelRoom": "210", "checkoutDate": str(today + dt.timedelta(days=3))},
    "daniel": {"fullName": "Daniel Kim", "nationality": "KR", "hotelRoom": "301", "checkoutDate": str(today + dt.timedelta(days=1))},
    "anna": {"fullName": "Anna Schmidt", "nationality": "DE", "hotelRoom": "215", "checkoutDate": str(today + dt.timedelta(days=5))},
}
cid = {k: call("POST", "/v1/customers", v)["id"] for k, v in people.items()}

M = call("GET", "/v1/asset-types")
sizes = {v["label"]: v["id"] for t in M if t["tracking"] == "quantity" for v in t["variants"]}


def rent(who, items, days, started_hours_ago):
    start = now - dt.timedelta(hours=started_hours_ago)
    return call("POST", "/v1/rentals", {"id": str(uuid.uuid4()), "customerId": cid[who], "days": days, "startAt": iso(start), "items": items})


rent("lukas", [{"assetId": units["C-03"]}], 2, 48 + 1.5)          # เลยกำหนด 1:30 ชม.
rent("emma", [{"assetId": units["C-07"]}], 3, 72 - 3.5)           # คืนวันนี้
rent("mia", [{"assetId": units["C-11"]}], 5, 120 - 5.5)           # คืนวันนี้
rent("james", [{"assetId": units["A-02"]}], 1, 24 - 6.5)          # คืนวันนี้
rent("daniel", [{"assetId": units["A-01"]}], 2, 48 - 7.5)         # คืนวันนี้
rent("sophie", [{"assetId": units["C-09"]}, {"variantId": sizes["M"], "quantity": 1}], 5, 100)
rent("noa", [{"assetId": units["C-08"]}], 3, 20)
rent("anna", [{"assetId": units["C-01"]}], 4, 2)
rent("emma", [{"variantId": sizes["L"], "quantity": 2}], 3, 70)
print("seed ok: รถ 16 คัน · ลูกค้า 8 คน · สัญญา 9 ใบ")
