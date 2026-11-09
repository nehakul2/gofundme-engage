import { handle, json, ApiError } from '@/lib/errors';
import { markRead } from '@/lib/notifications';

// POST /api/v1/me/notifications/read   { all: true } or { ids: [...] }
export const POST = handle(async (req: Request) => {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new ApiError(400, 'validation_failed', 'Body must be valid JSON'); }
  return json(await markRead(req.headers.get('x-user-id'), raw));
});
