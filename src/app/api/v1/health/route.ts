import { getPool } from '@/lib/db';
import { getRedis } from '@/lib/redis';
import { json } from '@/lib/errors';

export const dynamic = 'force-dynamic';

async function check(fn: () => Promise<unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), 4000))]);
    return { ok: true };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, error: err.code ?? (err.message ?? 'error').slice(0, 80) };
  }
}

export async function GET() {
  const env = {
    DATABASE_URL: !!process.env.DATABASE_URL,
    REDIS_URL: !!process.env.REDIS_URL,
    WEBHOOK_SECRET: !!process.env.WEBHOOK_SECRET,
  };
  const postgres = await check(() => getPool().query('SELECT 1'));
  const tables = postgres.ok
    ? await check(async () => {
        const r = await getPool().query("SELECT to_regclass('public.fundraisers') AS t");
        if (!r.rows[0].t) throw Object.assign(new Error('no fundraisers table'), { code: 'NO_TABLES' });
      })
    : { ok: false, error: 'skipped' };
  const redis = await check(() => getRedis().ping());
  const ok = env.DATABASE_URL && env.REDIS_URL && postgres.ok && tables.ok && redis.ok;
  return json({ ok, env, postgres, tables, redis }, ok ? 200 : 503, { 'cache-control': 'no-store' });
}
