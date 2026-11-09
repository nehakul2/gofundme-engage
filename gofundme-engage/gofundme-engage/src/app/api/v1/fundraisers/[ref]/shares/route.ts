import { handle, json, ApiError } from '@/lib/errors';
import { recordShare } from '@/lib/engagement';

// POST /api/v1/fundraisers/:ref/shares   { channel }
export const POST = handle(async (req: Request, { params }: { params: Promise<{ ref: string }> }) => {
  const { ref } = await params;
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new ApiError(400, 'validation_failed', 'Body must be valid JSON'); }
  const out = await recordShare(ref, raw, {
    userId: req.headers.get('x-user-id'),
    anonId: req.headers.get('x-anon-id'),
  });
  return json(out, 201);
});
