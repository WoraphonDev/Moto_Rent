import { describe, expect, it } from 'vitest';
import { parseScan } from '../src/components/qr-scanner';

describe('parseScan (ผลสแกน QR ที่รถ / พิมพ์รหัส)', () => {
  it('ลิงก์ QR ของร้าน → token', () => {
    expect(parseScan('https://app.example.com/q/4f2a9c1e0b7d4e8fa1c2')).toEqual({ token: '4f2a9c1e0b7d4e8fa1c2' });
    expect(parseScan('http://127.0.0.1:3100/q/abcdEF12_-xy?x=1')).toEqual({ token: 'abcdEF12_-xy' });
  });
  it('รหัสรถที่พิมพ์หรือยิงเครื่องสแกน → code ตัวใหญ่', () => {
    expect(parseScan(' c-03 ')).toEqual({ code: 'C-03' });
    expect(parseScan('A04')).toEqual({ code: 'A04' });
  });
  it('อย่างอื่นไม่รับ (QR ของคนอื่น ลิงก์แปลก ข้อความยาว)', () => {
    expect(parseScan('')).toBeNull();
    expect(parseScan('https://evil.example.com/login')).toBeNull();
    expect(parseScan('https://x.com/q/short')).toBeNull();
    expect(parseScan('hello world')).toBeNull();
  });
});
