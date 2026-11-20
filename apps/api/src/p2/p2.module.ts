import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { MaintenanceController } from './maintenance.controller.js';
import { ReportsController } from './reports.controller.js';
import { SettingsController } from './settings.controller.js';
import { StockController } from './stock.controller.js';

/** เฟส 2: ซ่อมบำรุง · ปรับสต็อก · ตั้งค่าร้าน · ประวัติการใช้งาน · รายงาน */
@Module({
  controllers: [MaintenanceController, StockController, SettingsController, AuditController, ReportsController],
  providers: [],
})
export class Phase2Module {}
