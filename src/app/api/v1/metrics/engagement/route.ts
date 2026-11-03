import { handle, json } from '@/lib/errors';
import { requireAdmin } from '@/lib/moderation';
import { engagementMetrics } from '@/lib/analytics';

// GET /api/v1/metrics/engagement?days=7   repeat visits and meaningful actions.
// Guarded by ADMIN_KEY when it is set (dev leaves it open).
export const GET = handle(async (req: Request) => {
  requireAdmin(req);
  const days = Number(new URL(req.url).searchParams.get('days') ?? 7);
  return json(await engagementMetrics(days), 200, { 'cache-control': 'private, max-age=30' });
});
