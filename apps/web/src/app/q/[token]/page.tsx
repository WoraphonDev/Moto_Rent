'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AssetImage, visualKind } from '@/components/asset-visual';
import { Skeleton } from '@/components/motion';
import { PublicFrame } from '../../book/public-frame';
import { api, ApiError } from '@/lib/api';
import type { QrPublic } from '@/lib/api-assets';
import styles from './q.module.css';

/**
 * ลิงก์ใน QR ที่ติดรถ (mock 10.01 / 10.02 / 10.05)
 * - เครื่องพนักงานที่เข้าระบบอยู่ → เปิด popup รถคันนั้นในหน้า "รถและของ"
 * - คนอื่น (ลูกค้า คนเจอรถ) → หน้าภาษาอังกฤษ: ชื่อร้าน + ช่องทางติดต่อ (ไม่มีข้อมูลลูกค้า)
 */
export default function QrPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [info, setInfo] = useState<QrPublic | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get<{ assetId: string }>(`/v1/assets/by-qr/${encodeURIComponent(token)}`);
        if (alive) router.replace(`/fleet?asset=${encodeURIComponent(data.assetId)}&scan=1`);
        return;
      } catch (e) {
        // ไม่ได้เข้าระบบ / ไม่ใช่รถของร้านที่เข้าอยู่ → หน้าสาธารณะ
        if (!(e instanceof ApiError) || ![401, 403, 404].includes(e.status)) {
          /* เน็ตหลุด ฯลฯ: ลองหน้าสาธารณะต่อ */
        }
      }
      try {
        const { data } = await api.get<QrPublic>(`/v1/public/q/${encodeURIComponent(token)}`);
        if (alive) setInfo(data);
      } catch {
        if (alive) setMissing(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, router]);

  if (missing) {
    return (
      <PublicFrame>
        <div className={styles.page}>
          <h1>QR code not found</h1>
          <p className="muted">This sticker is no longer valid. Please contact the rental shop directly.</p>
        </div>
      </PublicFrame>
    );
  }
  if (!info) {
    return (
      <PublicFrame>
        <div className={styles.page} aria-busy="true">
          <Skeleton h={34} w="60%" />
          <Skeleton h={220} />
          <Skeleton h={120} />
        </div>
      </PublicFrame>
    );
  }

  const wa = (info.contactWhatsapp ?? '').replace(/\D/g, '');
  const tel = (info.contactPhone ?? info.contactWhatsapp ?? '').replace(/[^\d+]/g, '');
  const kind = visualKind(info.typePublicName);
  return (
    <PublicFrame shopName={info.shopName}>
      <div className={`${styles.page} motion-list`}>
        <div>
          <h1>
            {/atv|quad/i.test(info.typePublicName) ? 'ATV' : info.typePublicName} {info.code}
          </h1>
          <p className="muted">This vehicle belongs to {info.shopName}.</p>
        </div>
        <AssetImage src={info.coverUrl ? `/api${info.coverUrl}` : null} kind={kind} alt={`${info.typePublicName} ${info.code}`} ratio={16 / 10} />
        <section className={styles.card}>
          <b>Renting this vehicle?</b>
          <p className="muted">Problem, flat tyre or accident? Message the shop — we come to you.</p>
          {wa.length >= 8 && (
            <a className={`btn ${styles.wa}`} href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">
              WhatsApp the shop
            </a>
          )}
          {tel.length >= 8 && (
            <a className="btn" href={`tel:${tel}`}>
              Call {info.contactPhone ?? info.contactWhatsapp}
            </a>
          )}
          {wa.length < 8 && tel.length < 8 && <p className="muted">Please contact the shop where you rented it.</p>}
        </section>
        {info.bookingEnabled && (
          <section className={styles.card}>
            <b>Want to rent one?</b>
            <Link className="btn" href={`/book/${encodeURIComponent(info.shopSlug)}`}>
              Book online →
            </Link>
          </section>
        )}
        <Link href={`/login?next=${encodeURIComponent(`/q/${token}`)}`} className={styles.staff}>
          Staff sign in
        </Link>
      </div>
    </PublicFrame>
  );
}
