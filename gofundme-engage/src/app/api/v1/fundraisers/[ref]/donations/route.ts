import { handle, json, ApiError } from '@/lib/errors';
import { createDonation, listDonations } from '@/lib/donations';

type Ctx = { params: Promise<{ ref: string }> };

// POST /api/v1/fundraisers/:ref/donations   (Idempotency-Key header required)
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { ref } = await params;
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    throw new ApiError(400, 'validation_failed', 'Body must be valid JSON');
  }
  // Dev auth stub: the x-user-id header stands in for a real session
  const result = await createDonation({
    ref,
    idempotencyKey: req.headers.get('idempotency-key'),
    rawBody,
    userId: req.headers.get('x-user-id'),
    visitorId: req.headers.get('x-user-id') ?? req.headers.get('x-anon-id'),
  });
  return json(result.body, result.status, result.headers);
});

// GET /api/v1/fundraisers/:ref/donations   recent supporters
export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { ref } = await params;
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 20);
  const items = await listDonations(ref, Number.isFinite(limit) ? limit : 20);
  return json({ items }, 200, { 'cache-control': 'public, s-maxage=5, stale-while-revalidate=30' });
});
