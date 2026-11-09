import { handle, json } from '@/lib/errors';
import { myCommunityState } from '@/lib/communities';

type Ctx = { params: Promise<{ slug: string }> };
// GET   the viewer's role in this community and the fundraisers they could still add
export const GET = handle(async (req: Request, { params }: Ctx) =>
  json(await myCommunityState(req.headers.get('x-user-id'), (await params).slug), 200, { 'cache-control': 'private, no-store' }));
