import { handle, json, ApiError } from '@/lib/errors';
import { MAX_COVER_BYTES, getCover, removeCover, setCover } from '@/lib/covers';

type Ctx = { params: Promise<{ ref: string }> };

// GET /api/v1/fundraisers/:ref/cover   the image. The URL carries a version, so it can be cached for a year.
export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const { ref } = await params;
  const c = await getCover(ref);
  return new Response(new Uint8Array(c.data), {
    status: 200,
    headers: {
      'content-type': c.content_type,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
});

// POST /api/v1/fundraisers/:ref/cover   the raw image as the request body (JPEG, PNG or WebP, up to 2 MB)
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { ref } = await params;
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_COVER_BYTES) throw new ApiError(413, 'file_too_large', 'The photo must be 2 MB or smaller', 'file');
  const bytes = new Uint8Array(await req.arrayBuffer());
  return json(await setCover(ref, req.headers.get('x-user-id'), req.headers.get('content-type'), bytes));
});

// DELETE /api/v1/fundraisers/:ref/cover   the organizer removes the photo
export const DELETE = handle(async (req: Request, { params }: Ctx) => {
  const { ref } = await params;
  return json(await removeCover(ref, req.headers.get('x-user-id')));
});
