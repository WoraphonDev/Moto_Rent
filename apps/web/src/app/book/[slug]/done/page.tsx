'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PublicFrame } from '../../public-frame';
import styles from '../../public.module.css';

/** ส่งคำขอแล้ว (mock 3.03) */
export default function BookDonePage() {
  const { slug } = useParams<{ slug: string }>();
  const [q, setQ] = useState<{ code: string; token: string } | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setQ({ code: p.get('code') ?? '', token: p.get('t') ?? '' });
  }, []);
  if (!q) return <PublicFrame>Loading…</PublicFrame>;
  const manage = q.token ? `/b/${encodeURIComponent(q.token)}` : null;

  return (
    <PublicFrame>
      <section className={styles.nowCard} aria-live="polite">
        <span className={styles.nowLabel}>Request sent</span>
        <span className={styles.code}>{q.code || '—'}</span>
        <span>Waiting for shop confirmation. The shop replies on WhatsApp during opening hours.</span>
      </section>

      <section className={styles.card}>
        <h2>What to bring</h2>
        <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 15 }}>
          <li>Your passport</li>
          <li>A valid driving licence for the vehicle</li>
          <li>Your booking code: <b>{q.code}</b></li>
        </ul>
        <div className={`${styles.note} ${styles.noteGreen}`}>No online payment. You pay at the shop.</div>
      </section>

      <section className={styles.card}>
        <h2>Your private booking link</h2>
        <p className="muted" style={{ fontSize: 14 }}>
          Save this link. You can check the status or cancel until 2 hours before pickup. Anyone with the link can see this booking, so do not share it.
        </p>
        {manage ? (
          <Link className={styles.primary} href={manage} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}>
            View my booking
          </Link>
        ) : (
          <span className="muted">The link was not received. Please message the shop with your code.</span>
        )}
        <Link className={styles.ghost} href={`/book/${encodeURIComponent(slug)}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', color: 'var(--ink)' }}>
          Make another booking
        </Link>
      </section>
    </PublicFrame>
  );
}
