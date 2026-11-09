import { handle, json } from '@/lib/errors';
import { getStats } from '@/lib/stats';

// GET /api/v1/fundraisers/:ref/stats   live totals, cached at the edge for 2 s
export const GET = handle(async (_req: Request, { params }: { params: Promise<{ ref: string }> }) => {
  const { ref } = await params;
  return json(await getStats(ref), 200, {
    'cache-control': 'public, s-maxage=2, stale-while-revalidate=10',
  });
});
