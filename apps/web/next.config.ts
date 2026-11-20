import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // ตอนพัฒนา: /api/* → API (production ใช้ Caddy ส่งตรงไป API ไม่ผ่าน Next)
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.API_ORIGIN ?? 'http://127.0.0.1:4100'}/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // หน้าตรวจ responsive ตอนพัฒนาใช้ iframe ของเว็บเดียวกัน · production ห้ามฝังทุกกรณี
          { key: 'X-Frame-Options', value: process.env.NODE_ENV === 'production' ? 'DENY' : 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(), microphone=()' },
          // CSP เฉพาะ production (dev ต้องใช้ eval ของ Next) · Caddy ใส่ค่าเดียวกันให้คำตอบของ API ด้วย
          ...(process.env.NODE_ENV === 'production'
            ? [
                {
                  key: 'Content-Security-Policy',
                  value:
                    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
                },
              ]
            : []),
        ],
      },
    ];
  },
};

export default config;
