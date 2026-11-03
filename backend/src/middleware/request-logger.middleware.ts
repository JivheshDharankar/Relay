import { Request, Response, NextFunction } from 'express';

const SENSITIVE_QUERY_PARAMS = new Set([
  'sessiontoken',
  'oauthgrant',
  'code',
  'state',
  'token',
  'otp',
  'otpcode',
]);

/**
 * Redacts sensitive query-string values (OAuth codes/grants, session tokens,
 * OTPs) so request logs never capture credentials.
 */
export function sanitizeUrlForLogging(originalUrl: string): string {
  const queryIndex = originalUrl.indexOf('?');
  if (queryIndex === -1) return originalUrl;
  const path = originalUrl.slice(0, queryIndex);
  const params = new URLSearchParams(originalUrl.slice(queryIndex + 1));
  let redacted = false;
  for (const key of Array.from(params.keys())) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      params.set(key, '[REDACTED]');
      redacted = true;
    }
  }
  return redacted ? `${path}?${params.toString()}` : originalUrl;
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = performance.now();

  res.on('finish', () => {
    const duration = Math.round((performance.now() - start) * 100) / 100;
    const logLine = `[${new Date().toISOString()}] ${req.method} ${sanitizeUrlForLogging(req.originalUrl)} ${res.statusCode} - ${duration}ms`;

    if (res.statusCode >= 500) {
      // eslint-disable-next-line no-console
      console.error(logLine);
    } else if (res.statusCode >= 400) {
      // eslint-disable-next-line no-console
      console.warn(logLine);
    } else {
      // eslint-disable-next-line no-console
      console.log(logLine);
    }
  });

  next();
}

