import { HttpStatus, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { SessionGuard } from './auth/session.guard.js';
import { RateLimiter } from './common/rate-limit.js';
import { HealthController } from './health.controller.js';
import { InfraModule } from './infra.js';
import { MembersController } from './members/members.controller.js';
import { AssetsController } from './rental/assets.controller.js';
import { BillsController } from './rental/bills.controller.js';
import { CustomersController } from './rental/customers.controller.js';
import { RentalsController } from './rental/rentals.controller.js';
import { TodayController } from './rental/today.controller.js';
import { StorageModule } from './common/storage.js';
import { Phase1ExtrasModule } from './p1/p1.module.js';
import { Phase2Module } from './p2/p2.module.js';
import { Phase3Module } from './p3/p3.module.js';

/**
 * กัน CSRF: คำขอที่เปลี่ยนข้อมูลต้องเป็น JSON
 * ฟอร์มจากเว็บอื่นส่ง JSON ข้ามโดเมนไม่ได้ถ้าไม่ผ่าน preflight · ใช้คู่กับ cookie SameSite=Lax
 */
function jsonOnly(req: Request, res: Response, next: NextFunction) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const hasBody = Number(req.get('content-length') ?? 0) > 0;
    if (hasBody && req.is('multipart/form-data')) {
      if (!req.get('x-requested-with')) {
        res.status(HttpStatus.FORBIDDEN).json({ error: 'csrf_header_required' });
        return;
      }
    } else if (hasBody && !req.is('application/json')) {
      res.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).json({ error: 'json_required' });
      return;
    }
    if (!hasBody && !req.get('x-requested-with')) {
      res.status(HttpStatus.FORBIDDEN).json({ error: 'csrf_header_required' });
      return;
    }
  }
  next();
}

@Module({
  imports: [InfraModule, StorageModule, Phase1ExtrasModule, Phase2Module, Phase3Module],
  controllers: [HealthController, AuthController, MembersController, AssetsController, CustomersController, RentalsController, BillsController, TodayController],
  providers: [AuthService, RateLimiter, SessionGuard],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(jsonOnly).forRoutes('*');
  }
}
