'use client';

import type { ReactNode } from 'react';
import { AssetImage, visualKind } from '@/components/asset-visual';
import type { Asset } from '@/lib/api';
import { STATE_BADGE, STATE_LABEL } from '@/lib/format';
import styles from './asset-card.module.css';

/**
 * การ์ดรูปรถ 1 คัน (mock 9.W1 / 8.W7)
 * - onSelect: แตะการ์ด (หน้าปล่อยเช่า = เลือก · หน้ารถ = เปิด popup)
 * - onInfo: ปุ่ม i เปิด popup (ใช้คู่กับการเลือก)
 */
export function AssetCard({
  asset,
  selected,
  onSelect,
  onInfo,
  sub,
  flag,
  disabled,
}: {
  asset: Asset;
  selected?: boolean;
  onSelect: () => void;
  onInfo?: () => void;
  sub?: ReactNode;
  flag?: ReactNode;
  disabled?: boolean;
}) {
  const label = `${asset.code} ${asset.typeName}${asset.color ? ` ${asset.color}` : ''}`;
  return (
    <div className={`${styles.card} motion-lift`} data-selected={selected || undefined} data-disabled={disabled || undefined}>
      <button type="button" className={styles.main} onClick={onSelect} disabled={disabled} aria-pressed={onInfo ? !!selected : undefined} aria-label={onInfo ? `${selected ? 'เอาออก' : 'เลือก'} ${label}` : `ดูรายละเอียด ${label}`}>
        <AssetImage mediaId={asset.coverMediaId} kind={visualKind(asset.typeName)} color={asset.color} alt={label} />
        <span className={styles.meta}>
          <b>{asset.code}</b>
          <span className={`badge ${STATE_BADGE[asset.state]}`}>{STATE_LABEL[asset.state]}</span>
        </span>
        <span className={styles.sub}>
          {sub ??
            [asset.color, asset.odometer !== null ? `ไมล์ ${asset.odometer.toLocaleString('en-US')}` : null].filter(Boolean).join(' · ')}
          {flag && <> · {flag}</>}
        </span>
      </button>
      {selected && (
        <span className={styles.check} aria-hidden="true">
          ✓
        </span>
      )}
      {onInfo && (
        <button type="button" className={styles.info} aria-label={`ดูรายละเอียด ${label}`} onClick={onInfo}>
          i
        </button>
      )}
    </div>
  );
}
