import { Module } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import { RateLimiter } from '../common/rate-limit.js';
import { BookingsController } from './bookings.controller.js';
import { PublicBookingController } from './public.controller.js';
import { TemplatesController } from './templates.controller.js';

/** เฟส 3: หน้าจองสาธารณะ · คำขอจอง · ปฏิทินรถ · เทมเพลตข้อความ */
@Module({
  controllers: [PublicBookingController, BookingsController, TemplatesController],
  providers: [RateLimiter, SessionGuard],
})
export class Phase3Module {}
