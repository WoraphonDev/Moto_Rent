/** รูปข้อมูลของเฟส 3 (การจอง) · เงินเป็นหน่วยย่อย (สตางค์) */

export type BookingStatus = 'requested' | 'confirmed' | 'rejected' | 'cancelled' | 'picked_up' | 'no_show';

export interface StaffBookingItem {
  id: string;
  assetTypeId: string;
  tracking: 'unit' | 'quantity';
  typeName: string;
  variantId: string | null;
  variantLabel: string | null;
  assetId: string | null;
  assetCode: string | null;
  quantity: number;
  pricePerDay: number;
  active: boolean;
  label: string;
}

export interface StaffBooking {
  id: string;
  code: string;
  status: BookingStatus;
  channel: string;
  fullName: string;
  whatsapp: string;
  email: string | null;
  hotelRoom: string | null;
  checkoutDate: string | null;
  hasLicense: boolean;
  pickupAt: string;
  returnAt: string;
  days: number;
  notes: string | null;
  source: string | null;
  customerId: string | null;
  rentalId: string | null;
  rejectReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  items: StaffBookingItem[];
  suggestions: Record<string, Array<{ id: string; code: string }>>;
  warnings: string[];
  total: number;
}

export interface CalendarSegment {
  kind: 'rental' | 'rental_returned' | 'booking' | 'maintenance';
  start: string;
  end: string;
  label: string;
  refId: string | null;
  overdue?: boolean;
}

export interface BookingCalendar {
  from: string;
  start: string;
  end: string;
  days: number;
  timezone: string;
  assets: Array<{ id: string; code: string; status: string; typeName: string; segments: CalendarSegment[] }>;
  requests: StaffBooking[];
}

export type TemplateKey = 'booking_confirmed' | 'booking_rejected' | 'return_reminder' | 'receipt' | 'thank_you';

export interface MessageTemplate {
  key: TemplateKey;
  body: string;
  isDefault: boolean;
  defaultBody: string;
  updatedAt: string | null;
  variables: string[];
}

export interface RenderedMessage {
  key: TemplateKey;
  text: string;
  phone: string | null;
  waUrl: string;
}

// ---------- หน้าจองสาธารณะ ----------

export interface PublicShop {
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  maxRentalDays: number | null;
  types: Array<{ id: string; name: string; tracking: 'unit' | 'quantity'; pricePerDay: number; deposit: number | null; variants: Array<{ id: string; label: string }> }>;
}

export interface PublicAvailability {
  from: string;
  to: string;
  types: Array<{ id: string; tracking: 'unit' | 'quantity'; available: number; variants?: Array<{ id: string; label: string; available: number }> }>;
}

export interface PublicBooking {
  code: string;
  status: BookingStatus;
  shopName: string;
  shopSlug: string;
  timezone: string;
  fullName: string;
  whatsappMasked: string;
  hotelRoom: string | null;
  checkoutDate: string | null;
  pickupAt: string;
  days: number;
  createdAt: string;
  rejectReason: string | null;
  cancellable: boolean;
  cancelWindowHours: number;
  total: number;
  items: Array<{ typeName: string; variantLabel: string | null; quantity: number; pricePerDay: number }>;
}

export const BOOKING_STATUS_TH: Record<BookingStatus, string> = {
  requested: 'รอยืนยัน',
  confirmed: 'ยืนยันแล้ว',
  rejected: 'ปฏิเสธ',
  cancelled: 'ลูกค้ายกเลิก',
  picked_up: 'รับรถแล้ว',
  no_show: 'ไม่มารับ',
};

export const BOOKING_STATUS_BADGE: Record<BookingStatus, string> = {
  requested: 'badge-warn',
  confirmed: 'badge-info',
  rejected: 'badge-danger',
  cancelled: 'badge-neutral',
  picked_up: 'badge-ok',
  no_show: 'badge-danger',
};

/** ฟอร์แมตเงินสำหรับหน้าลูกค้า (อังกฤษ) */
export function thb(minor: number): string {
  return `฿${(minor / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
