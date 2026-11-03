import express, { Express } from 'express';
import cors from 'cors';
import { env } from './config/env';
import { requestLogger } from './middleware/request-logger.middleware';
import { errorHandler } from './middleware/error-handler.middleware';
import { notFoundHandler } from './middleware/not-found.middleware';
import { appRouter } from './routes';

export function createApp(): Express {
  const app = express();

  // Trust X-Forwarded-For only behind an explicitly configured reverse proxy.
  if (env.TRUST_PROXY) {
    app.set('trust proxy', 1);
  }

  // Security & Cross-Origin Configuration. CORS_ORIGIN is an explicit
  // allowlist (comma-separated for local + preview origins). Never a
  // wildcard: credentialed requests require exact origins.
  const allowedOrigins = env.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    })
  );

  // Body Parsing Middleware
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Observability
  app.use(requestLogger);

  // Application Routes
  app.use('/', appRouter);

  // Fallbacks & Error Handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();

