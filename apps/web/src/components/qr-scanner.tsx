'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import styles from './qr-scanner.module.css';

/** แยกผลสแกน: ลิงก์ /q/<token> ของร้าน หรือรหัสรถที่พิมพ์/ยิงเครื่องสแกน (เช่น C-03) */
export function parseScan(text: string): { token: string } | { code: string } | null {
  const t = text.trim();
  if (!t) return null;
  const m = t.match(/\/q\/([A-Za-z0-9_-]{8,128})(?:[?#].*)?$/);
  if (m) return { token: m[1]! };
  if (/^[A-Za-z0-9]{1,5}-?\d{1,4}$/.test(t)) return { code: t.toUpperCase() };
  return null;
}

type Detector = { detect: (src: CanvasImageSource) => Promise<Array<{ rawValue: string }>> };

/**
 * กล้องสแกน QR เต็มจอ (mock 10.03)
 * ใช้ BarcodeDetector ของเครื่องถ้ามี (Android/Chrome) ไม่มีก็ถอดรหัสเองด้วย jsQR (iPhone)
 * สแกนต่อเนื่องได้หลายคัน · ผลเดิมซ้ำภายใน 2.5 วินาทีไม่นับ
 */
export function QrScanner({ open, onClose, onResult, footer }: { open: boolean; onClose: () => void; onResult: (text: string) => void; footer?: ReactNode }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState<boolean | null>(null);
  const [manual, setManual] = useState('');
  const stream = useRef<MediaStream | null>(null);
  const cb = useRef(onResult);
  cb.current = onResult;

  useEffect(() => {
    if (!open) return;
    let stop = false;
    let raf = 0;
    let last = { text: '', at: 0 };
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    (async () => {
      setError(null);
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
        if (stop) return s.getTracks().forEach((t) => t.stop());
        stream.current = s;
        const v = video.current!;
        v.srcObject = s;
        await v.play();
        const track = s.getVideoTracks()[0];
        const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
        setTorch(caps.torch ? false : null);

        const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
        const native = Native ? new Native({ formats: ['qr_code'] }) : null;
        const jsqr = native ? null : (await import('jsqr')).default;

        const found = (text: string) => {
          const now = Date.now();
          if (text === last.text && now - last.at < 2500) return;
          last = { text, at: now };
          navigator.vibrate?.(60);
          cb.current(text);
        };
        const tick = async () => {
          if (stop) return;
          if (v.readyState >= 2) {
            try {
              if (native) {
                const r = await native.detect(v);
                if (r[0]?.rawValue) found(r[0].rawValue);
              } else if (jsqr && ctx) {
                const w = Math.min(640, v.videoWidth);
                const h = Math.round((v.videoHeight / v.videoWidth) * w);
                canvas.width = w;
                canvas.height = h;
                ctx.drawImage(v, 0, 0, w, h);
                const img = ctx.getImageData(0, 0, w, h);
                const r = jsqr(img.data, w, h, { inversionAttempts: 'dontInvert' });
                if (r?.data) found(r.data);
              }
            } catch {
              /* เฟรมเสีย ข้ามไป */
            }
          }
          raf = window.setTimeout(() => requestAnimationFrame(() => void tick()), 180) as unknown as number;
        };
        void tick();
      } catch (e) {
        const name = (e as { name?: string }).name;
        setError(
          name === 'NotAllowedError'
            ? 'ไม่ได้อนุญาตให้ใช้กล้อง · เปิดสิทธิ์กล้องให้เว็บนี้ในการตั้งค่าเบราว์เซอร์ หรือพิมพ์รหัสแทน'
            : name === 'NotFoundError'
              ? 'ไม่พบกล้องในเครื่องนี้ · พิมพ์รหัสหรือใช้เครื่องยิงแทน'
              : 'เปิดกล้องไม่ได้ · พิมพ์รหัสแทน',
        );
      }
    })();

    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      stop = true;
      clearTimeout(raf);
      window.removeEventListener('keydown', onKey);
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
    };
  }, [open, onClose]);

  async function toggleTorch() {
    const track = stream.current?.getVideoTracks()[0];
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  }

  function submitManual(e: FormEvent) {
    e.preventDefault();
    if (!manual.trim()) return;
    cb.current(manual.trim());
    setManual('');
  }

  if (!open) return null;
  return (
    <div className={styles.wrap} role="dialog" aria-modal="true" aria-label="สแกน QR ที่รถ">
      <video ref={video} className={styles.video} playsInline muted aria-hidden="true" />
      <div className={styles.finder} aria-hidden="true">
        <i className={styles.tl} />
        <i className={styles.tr} />
        <i className={styles.bl} />
        <i className={styles.br} />
        <span className={styles.line} />
      </div>
      <header className={styles.head}>
        <button type="button" className={styles.round} aria-label="ปิด" onClick={onClose}>
          ×
        </button>
        <b>สแกน QR ที่รถ</b>
        {torch !== null ? (
          <button type="button" className={styles.round} aria-label={torch ? 'ปิดไฟฉาย' : 'เปิดไฟฉาย'} aria-pressed={torch} onClick={() => void toggleTorch()}>
            ☀
          </button>
        ) : (
          <span style={{ width: 44 }} />
        )}
      </header>
      <div className={styles.bottom}>
        {error && <div className="alert alert-danger">{error}</div>}
        {footer}
        <form className={styles.manual} onSubmit={submitManual}>
          <input className="input" placeholder="พิมพ์รหัสแทน เช่น C-03" value={manual} onChange={(e) => setManual(e.target.value)} aria-label="พิมพ์รหัสรถ" autoCapitalize="characters" />
          <button className="btn">ตกลง</button>
        </form>
        <span className={styles.hint}>สแกนต่อได้หลายคันติดกัน · กด × เมื่อเสร็จ</span>
      </div>
    </div>
  );
}
