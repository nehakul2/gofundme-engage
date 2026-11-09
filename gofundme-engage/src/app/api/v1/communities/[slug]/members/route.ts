import { handle, json } from '@/lib/errors';
import { setMembership } from '@/lib/communities';

type Ctx = { params: Promise<{ slug: string }> };
// POST joins, DELETE leaves (the owner cannot leave). Both are safe to repeat.
export const POST = handle(async (req: Request, { params }: Ctx) => json(await setMembership(req.headers.get('x-user-id'), (await params).slug, true)));
export const DELETE = handle(async (req: Request, { params }: Ctx) => json(await setMembership(req.headers.get('x-user-id'), (await params).slug, false)));
