// Tests run against a real Postgres and Redis (see docker-compose.yml).
process.env.DATABASE_URL ??= 'postgres://postgres:postgres@localhost:5432/gofundme_test';
process.env.REDIS_URL ??= 'redis://localhost:6379/1';
process.env.WEBHOOK_SECRET = 'test-secret';
delete process.env.MOCK_PROVIDER_WEBHOOK_URL; // tests deliver webhooks themselves
