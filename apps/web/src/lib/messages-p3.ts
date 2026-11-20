/** ข้อความ error ของเฟส 3 (เพิ่มได้เฉพาะในไฟล์นี้) · code จาก API → ข้อความไทย */
export const MESSAGES_P3: Record<string, string> = {
  asset_reserved: 'คันนี้ถูกจองไว้ในช่วงเวลานั้นแล้ว',
  booking_not_found: 'ไม่พบคำขอจองนี้',
  booking_closed: 'คำขอนี้ไม่ได้รอดำเนินการแล้ว',
  booking_customer_mismatch: 'ลูกค้าไม่ตรงกับคำขอจอง',
  assignment_required: 'ต้องเลือกคันให้ครบทุกรายการ',
  asset_wrong_type: 'คันที่เลือกไม่ตรงประเภทที่ลูกค้าขอ',
  template_not_found: 'ไม่พบเทมเพลตนี้',
  shop_not_found: 'ไม่พบร้านนี้',
  invalid_range: 'ช่วงวันไม่ถูกต้อง',
  not_available: 'ช่วงนั้นไม่ว่างแล้ว',
  invalid_name: 'ชื่อต้องไม่มีลิงก์หรือชื่อเว็บไซต์',
  phone_format: 'เบอร์โทรไม่ถูกต้อง',
};

/** ข้อความ error สำหรับหน้าลูกค้า (ภาษาอังกฤษ) */
export const PUBLIC_MESSAGES: Record<string, string> = {
  shop_not_found: "This shop isn't taking online bookings. Please message the shop directly.",
  invalid_name: 'Please enter your name only, without links or website addresses.',
  phone_format: 'Please enter a valid WhatsApp number with country code, e.g. +49 151 1234 5678.',
  not_available: 'Sorry, that vehicle is no longer available for those dates. Please choose other dates.',
  too_many_days: 'That is longer than this shop allows. Please choose fewer days.',
  invalid_pickup: 'Please choose a pickup time in the future (up to 120 days ahead).',
  invalid_item: 'Please choose a vehicle again.',
  invalid_input: 'Please check the form and try again.',
  rate_limited: 'Too many booking requests right now. Please wait a little and try again, or message the shop.',
  booking_not_found: 'This booking link is not valid.',
  booking_not_cancellable: 'This booking can no longer be cancelled online. Please message the shop.',
  network_error: 'No connection. Please check your internet and try again.',
};

export function publicMessage(e: unknown): string {
  const code = (e as { code?: string })?.code;
  return (code && PUBLIC_MESSAGES[code]) || 'Something went wrong. Please try again.';
}
