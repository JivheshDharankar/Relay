import { defineConfig } from 'vitest/config';

export default defineConfig({
  css: {
    postcss: {
      plugins: [],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Hermetic test provider: the suite asserts deterministic mock-model
    // behavior and must not follow the served runtime's MODEL_PROVIDER
    // (meta). dotenv never overrides an already-set variable.
    env: {
      MODEL_PROVIDER: 'mock',
      // Exercise the trusted-reverse-proxy rate-limit path in tests (per-IP
      // buckets via X-Forwarded-For). Production default is untrusted: raw
      // client XFF headers are ignored (see 10.7).
      TRUST_PROXY: 'true',
    },
    testTimeout: 10000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});


