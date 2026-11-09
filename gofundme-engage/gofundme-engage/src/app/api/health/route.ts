import { getPool } from '@/lib/db';
import { getRedis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

// GET /api/health   used by the load balancer; checks both stores
export async function GET() {
  try {
    await Promise.all([getPool().query('SELECT 1'), getRedis().ping()]);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
