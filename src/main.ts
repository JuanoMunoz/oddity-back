import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
  });

  // Explicitly add body parsers with higher limits
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ limit: '50mb', extended: true }));

  // Trust proxy for Render/Vercel/Cloudflare (to handle secure cookies correctly)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).set('trust proxy', true);

  const origins = [
    process.env.BASE_URL_FRONTEND?.replace(/"/g, ''),
    'http://localhost:5173',
    'https://oddity-front.vercel.app',
  ].filter(Boolean);

  // Add any extra origins from an environment variable if defined
  if (process.env.TRUSTED_ORIGINS) {
    origins.push(...process.env.TRUSTED_ORIGINS.split(','));
  }

  app.enableCors({
    origin: origins as string[],
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
