/*
 * service worker ของแอปหลังร้าน (PWA)
 * - ไฟล์ของแอป (/_next/static, ฟอนต์, ไอคอน): เก็บไว้ในเครื่อง ใช้ของในเครื่องก่อน (ชื่อไฟล์มี hash เปลี่ยนเมื่อมีเวอร์ชันใหม่)
 * - หน้าเว็บ: ขอจากเน็ตก่อน · เน็ตหลุดใช้หน้าที่เคยเปิด จึงเปิดแอปได้แม้ออฟไลน์
 * - /b/*, /book/*/done: ไม่เก็บ (มีข้อมูลลูกค้า)
 * - /api/*: ไม่เก็บเด็ดขาด (ข้อมูลลูกค้า/เงินต้องสดและไม่ค้างในเครื่อง) · งานที่ต้องส่งตอนออฟไลน์อยู่ใน lib/offline.ts
 */
// เปลี่ยนเวอร์ชัน = ล้างหน้าที่เคยเก็บไว้ทั้งหมด (v2: เลิกเก็บหน้าบิล/หน้าจองเสร็จที่มีข้อมูลลูกค้า)
const VERSION = 'rental-v2';
const STATIC_CACHE = `${VERSION}-static`;
const PAGE_CACHE = `${VERSION}-pages`;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isStatic(url) {
  return url.pathname.startsWith('/_next/static/') || url.pathname === '/icon.svg' || /\.(woff2?|ttf|otf)$/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  // หน้าบิลของลูกค้า (/b/…) หน้าเซ็นสัญญา (/sign/…) และหน้าจองเสร็จ (/book/…/done) มีข้อมูลส่วนตัว · ไม่เก็บในเครื่อง
  if (url.pathname.startsWith('/b/') || url.pathname.startsWith('/sign/') || /^\/book\/[^/]+\/done\/?$/.test(url.pathname)) return;

  if (isStatic(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // clone ก่อนคืน response (body อ่านได้ครั้งเดียว)
          if (res.ok) {
            const copy = res.clone();
            caches.open(PAGE_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(req)) || (await caches.match('/')) || Response.error()),
    );
  }
});
