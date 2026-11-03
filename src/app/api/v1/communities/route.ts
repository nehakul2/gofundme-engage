import { handle, json, ApiError } from '@/lib/errors';
import { createCommunity, searchCommunities } from '@/lib/communities';

// POST /api/v1/communities   returns the created community (201); the creator is its owner
export const POST = handle(async (req: Request) => {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new ApiError(400, 'validation_failed', 'Body must be valid JSON'); }
  const c = await createCommunity(req.headers.get('x-user-id'), raw);
  return json(c, 201, { location: `/api/v1/communities/${c.slug}` });
});

// GET /api/v1/communities?q=   up to 5 communities whose name or description contains every word
export const GET = handle(async (req: Request) => {
  const q = new URL(req.url).searchParams.get('q') ?? '';
  return json({ results: await searchCommunities(q) }, 200, { 'cache-control': 'no-store' });
});
