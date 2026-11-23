// Tests run against a real Postgres and Redis (see docker-compose.yml).
process.env.DATABASE_URL ??= 'postgres://postgres:postgres@localhost:5432/gofundme_test';
process.env.REDIS_URL ??= 'redis://localhost:6379/1';
process.env.WEBHOOK_SECRET = 'test-secret';
delete process.env.MOCK_PROVIDER_WEBHOOK_URL; // tests deliver webhooks themselves

// Safety guard: the suites drop and recreate tables, so refuse to run against anything but a local database.
{
  const host = (() => { try { return new URL(process.env.DATABASE_URL!).hostname; } catch { return ''; } })();
  const dbName = (() => { try { return new URL(process.env.DATABASE_URL!).pathname.slice(1); } catch { return ''; } })();
  if (!dbName.endsWith('_test') && process.env.ALLOW_REMOTE_TEST_DB !== 'yes') {
    throw new Error(`Refusing to run tests against database "${dbName}": the name must end in _test. Tests wipe data.`);
  }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]', 'postgres'].includes(host);
  if (!local && process.env.ALLOW_REMOTE_TEST_DB !== 'yes') {
    throw new Error(`Refusing to run tests against DATABASE_URL host "${host}". Tests wipe data. Unset DATABASE_URL to use the local test database.`);
  }
}
