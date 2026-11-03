import { prisma } from '../config/prisma';

export interface DatabasePingResult {
  connected: boolean;
  latencyMs: number;
  error?: string;
}

export class HealthRepository {
  /**
   * Executes a lightweight database ping query and measures roundtrip latency
   */
  public async pingDatabase(): Promise<DatabasePingResult> {
    const start = performance.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      const latencyMs = Math.round((performance.now() - start) * 100) / 100;
      return {
        connected: true,
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Math.round((performance.now() - start) * 100) / 100;
      return {
        connected: false,
        latencyMs,
        error: err instanceof Error ? err.message : 'Unknown database error',
      };
    }
  }

  /**
   * Records a health heartbeat to verify write/read model against PostgreSQL
   */
  public async recordHeartbeat(service = 'relay-backend'): Promise<void> {
    await prisma.systemHealthRecord.create({
      data: {
        service,
        status: 'ok',
        metadata: {
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
        },
      },
    });
  }
}

export const healthRepository = new HealthRepository();

