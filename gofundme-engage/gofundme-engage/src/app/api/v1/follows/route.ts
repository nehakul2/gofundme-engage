import { handle, json, ApiError } from '@/lib/errors';
import { requireUser, setFollow } from '@/lib/engagement';

async function body(req: Request) {
  try { return await req.json(); } catch { throw new ApiError(400, 'validation_failed', 'Body must be valid JSON'); }
}

// POST /api/v1/follows   { target_type, target_id }   idempotent
export const POST = handle(async (req: Request) => {
  const userId = requireUser(req.headers.get('x-user-id'));
  return json(await setFollow(userId, await body(req), true));
});

// DELETE /api/v1/follows   same body; unfollowing twice is fine
export const DELETE = handle(async (req: Request) => {
  const userId = requireUser(req.headers.get('x-user-id'));
  return json(await setFollow(userId, await body(req), false));
});
