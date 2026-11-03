import { handle, json } from '@/lib/errors';
import { listNotifications } from '@/lib/notifications';

// GET /api/v1/me/notifications?limit=30   the viewer's inbox, newest first; never cached
export const GET = handle(async (req: Request) => {
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 30);
  const items = await listNotifications(req.headers.get('x-user-id'), limit);
  return json({ items }, 200, { 'cache-control': 'private, no-store' });
});
