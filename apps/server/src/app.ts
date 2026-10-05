import 'reflect-metadata';
import { Module, Catch, ExceptionFilter, ArgumentsHost, HttpException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { json } from 'express';
import { ZodError } from 'zod';
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthController, PlatformController } from './api';
import { RetentionController, AlertsController, TestingController } from './operations-api';
import { AuthGuard } from './auth';
import { db } from './db';
import { redis } from './queue';
import { config } from './config';
import { logger, registry } from './observability';
import { UnsafeDestination } from './destination';
@Catch()
class Errors implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : error instanceof ZodError || error instanceof UnsafeDestination
          ? 400
          : error.code === 'P2002'
            ? 409
            : error.status === 400 || error.status === 413
              ? error.status
              : 500;
    if (status === 500) logger.error({ err: error }, 'Request failed');
    response.status(status).json({
      statusCode: status,
      message:
        status === 500
          ? 'Internal server error'
          : error instanceof ZodError
            ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
            : error.code === 'P2002'
              ? 'Resource already exists'
              : error.message,
    });
  }
}
@Controller()
class HealthController {
  @Get('health')
  async health(@Res() res: Response) {
    const results = await Promise.allSettled([db.$queryRaw`SELECT 1`, redis.ping()]);
    const healthy = results.every((r) => r.status === 'fulfilled');
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      database: results[0].status === 'fulfilled',
      redis: results[1].status === 'fulfilled',
    });
  }
  @Get('metrics')
  async metrics(@Res() res: Response) {
    res.type(registry.contentType).send(await registry.metrics());
  }
}
@Module({
  controllers: [
    AuthController,
    PlatformController,
    HealthController,
    RetentionController,
    AlertsController,
    TestingController,
  ],
  providers: [AuthGuard],
})
class AppModule {}
export async function createApp() {
  const app = await NestFactory.create(AppModule, { logger: false, bodyParser: false });
  app.use(helmet());
  app.use(json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => ['/health', '/metrics'].includes(req.url ?? '') },
    }),
  );
  app.enableCors({
    origin: config.WEB_ORIGIN,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Organization-Id', 'Idempotency-Key'],
  });
  app.useGlobalFilters(new Errors());
  app.enableShutdownHooks();
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Relay webhook platform')
      .setDescription(
        'Tenant-scoped webhook delivery. API keys use explicit publishing, reading, replay, and testing scopes; browser owners manage workspaces.',
      )
      .setVersion('0.1.0')
      .addBearerAuth()
      .addCookieAuth('relay_session')
      .build(),
  );
  SwaggerModule.setup('docs', app, document);
  return app;
}
