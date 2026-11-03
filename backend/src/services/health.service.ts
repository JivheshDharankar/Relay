import { env } from '../config/env';
import { HealthStatus } from '../domain';
import { healthRepository } from '../repositories/health.repository';

export class HealthService {
  public async getHealth(): Promise<HealthStatus> {
    const dbPing = await healthRepository.pingDatabase();

    const isHealthy = dbPing.connected;

    return {
      status: isHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      environment: env.NODE_ENV,
      version: '0.1.0',
      database: {
        status: dbPing.connected ? 'connected' : 'disconnected',
        latencyMs: dbPing.latencyMs,
        ...(dbPing.error ? { error: dbPing.error } : {}),
      },
    };
  }
}

export const healthService = new HealthService();

