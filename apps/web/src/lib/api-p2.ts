/** รูปข้อมูลจาก API เฟส 2 · เงินเป็นหน่วยย่อย (สตางค์) */
import type { PaymentMethod, Role } from './api';

export type Urgency = 'overdue' | 'soon' | 'ok';
export type MaintenanceKind = 'oil' | 'tire' | 'brake' | 'repair' | 'insurance' | 'tax' | 'other';

export interface DueItem {
  kind: 'oil' | 'insurance' | 'tax';
  urgency: Urgency;
  remaining: number;
  dueAt: string | number;
}

export interface DueAsset {
  id: string;
  code: string;
  model: string | null;
  status: 'available' | 'maintenance' | 'retired';
  odometer: number | null;
  nextServiceOdometer: number | null;
  insuranceExpiresOn: string | null;
  taxExpiresOn: string | null;
  typeName: string;
  serviceIntervalKm: number | null;
  items: DueItem[];
  urgency: Urgency;
}

export interface MaintenanceRecord {
  id: string;
  assetId: string;
  code: string;
  kind: MaintenanceKind;
  description: string;
  cost: number;
  odometer: number | null;
  performedOn: string;
  by: string;
  createdAt: string;
}

export interface StockAdjustment {
  id: string;
  delta: number;
  reason: string;
  createdAt: string;
  by: string;
}

export interface OrgSettings {
  orgId: string;
  lateGraceMinutes: number;
  lateHalfDayUntilMinutes: number;
  maxRentalDays: number | null;
  depositNonGuest: number | null;
  staffDiscountCap: number;
  docRetentionDays: number;
  idleLockMinutes: number;
  /** เปิดหน้าจองออนไลน์ /book/<slug> (ร้านใหม่ปิดไว้ก่อน) */
  publicBookingEnabled: boolean;
  /** ช่องทางติดต่อร้าน (หน้าสแกน QR ติดรถ) · null = ไม่แสดง */
  contactWhatsapp?: string | null;
  contactPhone?: string | null;
}

export interface SettingsResponse {
  settings: OrgSettings;
  org: { id: string; name: string; slug: string; timezone: string; currency: string };
  staff: Array<{ userId: string; displayName: string; username: string; role: Role; discountLimit: number | null }>;
}

export interface AuditItem {
  id: number;
  createdAt: string;
  action: string;
  entityType: string;
  entityId: string | null;
  risk: 'normal' | 'risky';
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  ip: string | null;
  actorId: string | null;
  actorName: string | null;
  deviceName: string | null;
}

export interface AuditPage {
  items: AuditItem[];
  nextCursor: string | null;
  actors: Array<{ id: string; displayName: string }>;
}

export interface ReportSummary {
  range: { from: string; to: string; timezone: string; hours: number };
  totals: {
    revenue: number;
    payments: number;
    openBills: number;
    openBillCount: number;
    rentals: number;
    unattributedRevenue: number;
    maintenanceCost: number;
    avgUtilizationPct: number;
  };
  revenueByKind: Array<{ kind: string; amount: number }>;
  paymentsByMethod: Array<{ method: PaymentMethod; amount: number; count: number }>;
  daily: Array<{ date: string; revenue: number; payments: number }>;
  revenueByType: Array<{ typeId: string; name: string; tracking: 'unit' | 'quantity'; revenue: number }>;
  assets: Array<{ assetId: string; code: string; typeName: string; revenue: number; maintenanceCost: number; profit: number; rentedHours: number; utilizationPct: number }>;
  channels: { byChannel: Array<{ channel: string; count: number }>; hotelGuests: number; nonHotel: number };
}
