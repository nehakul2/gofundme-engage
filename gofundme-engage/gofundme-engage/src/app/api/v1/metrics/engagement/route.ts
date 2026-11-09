import { handle, json, ApiError } from '@/lib/errors';
import { engagementMetrics } from '@/lib/analytics';

// GET /api/v1/metrics/engagement?days=7   repeat visits and meaningful actions.
// Guarded by ADMIN_KEY when it is set (dev leaves it open).
export const GET = handle(async (req: Request) => {
  const key = process.env.ADMIN_KEY;
  if (key && req.headers.get('x-admin-key') !== key) throw new ApiError(403, 'forbidden', 'Admin key required');
  const days = Number(new URL(req.url).searchParams.get('days') ?? 7);
  return json(await engagementMetrics(days), 200, { 'cache-control': 'private, max-age=30' });
});
