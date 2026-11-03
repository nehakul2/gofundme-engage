import { handle, json, ApiError } from '@/lib/errors';
import { etagOf, getFundraiserVersion, patchFundraiser } from '@/lib/fundraisers';

type Ctx = { params: Promise<{ ref: string }> };

// GET /api/v1/fundraisers/:ref   the fundraiser plus its ETag, for edit forms
export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const f = await getFundraiserVersion((await params).ref);
  if (f.status === 'removed') throw new ApiError(410, 'gone', 'This fundraiser has been removed');
  return json(f, 200, { etag: etagOf(f.version), 'cache-control': 'private, no-cache' });
});

// PATCH /api/v1/fundraisers/:ref   requires If-Match (428 without it, 412 if stale)
export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new ApiError(400, 'validation_failed', 'Body must be valid JSON'); }
  const f = await patchFundraiser((await params).ref, req.headers.get('x-user-id'), req.headers.get('if-match'), raw);
  return json(f, 200, { etag: etagOf(f.version) });
});
