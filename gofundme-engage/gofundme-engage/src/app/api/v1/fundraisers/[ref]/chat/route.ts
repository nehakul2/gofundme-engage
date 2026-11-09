import { handle, json, ApiError } from '@/lib/errors';
import { listMessages, postMessage } from '@/lib/chat';

type Ctx = { params: Promise<{ ref: string }> };

// GET /api/v1/fundraisers/:ref/chat?before=<id>|after=<id>&limit=50   anyone can read
export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { ref } = await params;
  const sp = new URL(req.url).searchParams;
  const out = await listMessages(ref, { before: sp.get('before'), after: sp.get('after'), limit: sp.get('limit') ?? 50 });
  return json(out, 200, { 'cache-control': 'no-store' });
});

// POST /api/v1/fundraisers/:ref/chat   { body, client_id? }   signed-in users only
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { ref } = await params;
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new ApiError(400, 'validation_failed', 'Body must be valid JSON'); }
  const { message, replay } = await postMessage(ref, req.headers.get('x-user-id'), raw);
  return json(message, replay ? 200 : 201, replay ? { 'idempotent-replay': 'true' } : {});
});
