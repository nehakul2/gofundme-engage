import { handle, json, ApiError } from '@/lib/errors';
import { addFundraiser } from '@/lib/communities';

type Ctx = { params: Promise<{ slug: string }> };
// POST {fundraiser: "<slug>"}   a member lists one of their own fundraisers in the community
export const POST = handle(async (req: Request, { params }: Ctx) => {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new ApiError(400, 'validation_failed', 'Body must be valid JSON'); }
  return json(await addFundraiser(req.headers.get('x-user-id'), (await params).slug, raw));
});
