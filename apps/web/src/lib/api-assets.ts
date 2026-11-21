// ชนิดข้อมูลของ popup รถ/อุปกรณ์ และ QR (mock 9.W2 / 9.W3 / 10.*)

export type AssetLiveState = 'available' | 'rented' | 'overdue' | 'maintenance' | 'retired';

export interface AssetDetail {
  asset: {
    id: string;
    code: string;
    typeId: string;
    typeName: string;
    publicName: string | null;
    tracking: 'unit' | 'quantity';
    model: string | null;
    plate: string | null;
    color: string | null;
    odometer: number | null;
    status: 'available' | 'maintenance' | 'retired';
    pricePerDay: number;
    notes: string | null;
    coverMediaId: string | null;
    ownCover: boolean;
    qrToken: string;
    ownPrice?: number | null;
    insuranceExpiresOn?: string | null;
    taxExpiresOn?: string | null;
  };
  state: AssetLiveState;
  currentRental: null | { id: string; customerName: string; room: string | null; dueAt: string; lateFeeSoFar?: number };
  nextBooking: null | { id: string; code: string; pickupAt: string; fullName: string };
  service: { intervalKm: number | null; nextServiceOdometer: number | null; remainingKm: number | null };
  lastReturnPhotos: Array<{ mediaId: string; slot: string; takenAt: string; takenByName: string | null }>;
  lastReturnAt: string | null;
  lastReturnByName: string | null;
  damage: Array<{ description: string; amount: number; at: string }>;
  history: Array<{ rentalId: string; customerName: string; startAt: string; returnedAt: string | null; status: string; lateFee: number }>;
}

export interface GearDetail {
  type: { id: string; name: string; publicName: string | null; pricePerDay: number; coverMediaId: string | null };
  variants: Array<{ id: string; label: string; quantity: number; out: number; booked: number; available: number }>;
}

export interface QrPublic {
  shopName: string;
  shopSlug: string;
  code: string;
  typeId: string;
  typePublicName: string;
  contactWhatsapp: string | null;
  contactPhone: string | null;
  bookingEnabled: boolean;
  hasCover: boolean;
  /** รูปหน้าปกแบบสาธารณะ (ถ้ามี) */
  coverUrl?: string | null;
}

/** ลิงก์ใน QR ที่ติดรถ */
export const qrLink = (origin: string, token: string) => `${origin}/q/${encodeURIComponent(token)}`;
