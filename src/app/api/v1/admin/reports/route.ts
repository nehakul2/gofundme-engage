import { handle, json } from '@/lib/errors';
import { openReports, requireAdmin } from '@/lib/moderation';

// GET /api/v1/admin/reports   open chat reports grouped by message (x-admin-key when ADMIN_KEY is set)
export const GET = handle(async (req: Request) => {
  requireAdmin(req);
  return json({ reports: await openReports() }, 200, { 'cache-control': 'private, no-store' });
});
