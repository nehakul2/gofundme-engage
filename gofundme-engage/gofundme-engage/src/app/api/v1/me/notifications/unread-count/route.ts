import { handle, json } from '@/lib/errors';
import { unreadCount } from '@/lib/notifications';

// GET /api/v1/me/notifications/unread-count   the bell badge; never cached
export const GET = handle(async (req: Request) => {
  return json({ unread_count: await unreadCount(req.headers.get('x-user-id')) }, 200, { 'cache-control': 'private, no-store' });
});
