import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';

/** สร้างแอป (ใช้ทั้ง main และเทสต์) */
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn', 'log'], bodyParser: false });
  // อยู่หลัง Caddy/load balancer 1 ชั้น: เชื่อ X-Forwarded-For ชั้นเดียว เพื่อให้ req.ip เป็น IP จริงของเครื่องลูกข่าย
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '256kb' });
  app.use(cookieParser());
  app.enableShutdownHooks();
  return app;
}
