import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const corsOrigin = config.get<string>('ADMIN_CORS_ORIGIN') ?? true;
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: corsOrigin,
    credentials: true,
  });

  const port = Number(config.get<string>('ADMIN_BACKEND_PORT') ?? '3001');
  await app.listen(port);
  console.log(`[admin-backend] слушает порт ${port}`);
}

void bootstrap();
