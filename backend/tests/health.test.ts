import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { healthService } from '../src/services/health.service';

describe('GET /health', () => {
  it('should return 200 and healthy status when database is reachable', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('uptimeSeconds');
    expect(res.body).toHaveProperty('database');
    expect(res.body.database).toHaveProperty('status', 'connected');
    expect(typeof res.body.database.latencyMs).toBe('number');
  });

  it('should return 503 and degraded status when database is disconnected', async () => {
    const spy = vi.spyOn(healthService, 'getHealth').mockResolvedValueOnce({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      uptimeSeconds: 10,
      environment: 'test',
      version: '0.1.0',
      database: {
        status: 'disconnected',
        error: 'Connection timeout',
      },
    });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toHaveProperty('status', 'degraded');
    expect(res.body.database).toHaveProperty('status', 'disconnected');

    spy.mockRestore();
  });

  it('should return 404 for unknown endpoints', async () => {
    const res = await request(app).get('/api/unknown-endpoint');

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('code', 'NOT_FOUND');
  });
});

