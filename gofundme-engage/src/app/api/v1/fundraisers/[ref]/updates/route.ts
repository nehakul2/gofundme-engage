import { handle, json, ApiError } from '@/lib/errors';
import { getTimeline, postUpdate } from '@/lib/updates';

type Ctx = { params: Promise<{ ref: string }> };

// GET /api/v1/fundraisers/:ref/updates   organizer updates and milestones, newest first (anyone can read)
export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { ref } = await params;
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 30);
  return json({ items: await getTimeline(ref, limit) }, 200, { 'cache-control': 'no-store' });
});

// POST /api/v1/fundraisers/:ref/updates   { body, client_id? }   the organizer only
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { ref } = await params;
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new ApiError(400, 'validation_failed', 'Body must be valid JSON'); }
  const { update, replay } = await postUpdate(ref, req.headers.get('x-user-id'), raw);
  return json(update, replay ? 200 : 201, replay ? { 'idempotent-replay': 'true' } : {});
});
