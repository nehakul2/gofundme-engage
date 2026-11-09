import { handle, json } from '@/lib/errors';
import { isFollowing, requireUser } from '@/lib/engagement';

// GET /api/v1/me/relations?type=fundraiser&id=...   the viewer's own state; never cached
export const GET = handle(async (req: Request) => {
  const userId = requireUser(req.headers.get('x-user-id'));
  const q = new URL(req.url).searchParams;
  const type = q.get('type') ?? '';
  const id = q.get('id') ?? '';
  const following = ['user', 'fundraiser', 'community'].includes(type) ? await isFollowing(userId, type, id) : false;
  return json({ following }, 200, { 'cache-control': 'private, no-store' });
});
