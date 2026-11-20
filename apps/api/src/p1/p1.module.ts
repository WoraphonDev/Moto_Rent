import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RateLimiter } from '../common/rate-limit.js';
import { SessionGuard } from '../auth/session.guard.js';
import { DayCloseController } from './day-close.controller.js';
import { MediaController } from './media.controller.js';
import { PurgeService } from './purge.service.js';
import { DocumentRetentionInterceptor } from './retention.interceptor.js';
import { ConfirmStaffController, SignController } from './sign.controller.js';

/** เฟส 1 ส่วนที่เหลือ: รูป/เอกสาร · ลายเซ็นลูกค้า · ปิดยอดสิ้นวัน · ลบเอกสารตามกำหนด */
@Module({
  controllers: [MediaController, SignController, ConfirmStaffController, DayCloseController],
  providers: [PurgeService, RateLimiter, SessionGuard, { provide: APP_INTERCEPTOR, useClass: DocumentRetentionInterceptor }],
})
export class Phase1ExtrasModule {}
