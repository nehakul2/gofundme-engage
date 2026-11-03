import { handle, json, ApiError } from '@/lib/errors';
import { createFundraiser, etagOf, CREATE_LIMIT, CREATE_WINDOW_S } from '@/lib/fundraisers';
import { requireUser } from '@/lib/engagement';
import { getPool } from '@/lib/db';
import { getRedis, keys } from '@/lib/redis';


// POST /api/v1/fundraisers   returns the created object (201) so no read-back is needed
export const POST = handle(async (req: Request) => {
  const userId = requireUser(req.headers.get('x-user-id'));
  const known = await getPool().query('SELECT 1 FROM users WHERE id = $1', [userId]);
  if (!known.rowCount) throw new ApiError(401, 'unauthenticated', 'Sign in to do this');
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new ApiError(400, 'validation_failed', 'Body must be valid JSON'); }
  const r = getRedis();
  const rateKey = keys.createRate(userId);
  const used = await r.incr(rateKey);
  if (used === 1) await r.expire(rateKey, CREATE_WINDOW_S);
  if (used > CREATE_LIMIT) {
    const ttl = Math.max(await r.ttl(rateKey), 1);
    throw new ApiError(429, 'rate_limited', `You can start ${CREATE_LIMIT} fundraisers per hour. Try again later.`, undefined, { 'retry-after': String(ttl) });
  }
  const f = await createFundraiser(userId, raw);
  return json(f, 201, { etag: etagOf(f.version), location: `/api/v1/fundraisers/${f.slug}` });
});
