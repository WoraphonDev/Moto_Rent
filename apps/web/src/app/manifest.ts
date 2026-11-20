import type { MetadataRoute } from 'next';

/** ติดตั้งเป็นแอปบนมือถือ/แท็บเล็ตหน้าร้านได้ (PWA) */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ร้านเช่า · หลังร้าน',
    short_name: 'ร้านเช่า',
    start_url: '/',
    display: 'standalone',
    background_color: '#fbf5ec',
    theme_color: '#2a211b',
    lang: 'th',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
