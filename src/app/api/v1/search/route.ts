import { handle, json } from '@/lib/errors';
import { searchFundraisers } from '@/lib/search';

// GET /api/v1/search?q=wildfire&limit=20   find fundraisers and whether they can take donations
export const GET = handle(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const out = await searchFundraisers(sp.get('q'), sp.get('limit') ?? 20);
  return json(out, 200, { 'cache-control': 'public, max-age=5, s-maxage=5' });
});
