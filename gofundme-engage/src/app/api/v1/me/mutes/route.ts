import { handle, json, ApiError } from '@/lib/errors';
import { listMutes, setMute } from '@/lib/moderation';

const body = async (req: Request) => { try { return await req.json(); } catch { throw new ApiError(400, 'validation_failed', 'Body must be valid JSON'); } };

// GET lists who the viewer has muted; POST { user_id } mutes; DELETE { user_id } unmutes. Chat only, only for the viewer.
export const GET = handle(async (req: Request) => json(await listMutes(req.headers.get('x-user-id')), 200, { 'cache-control': 'private, no-store' }));
export const POST = handle(async (req: Request) => json(await setMute(req.headers.get('x-user-id'), await body(req), true)));
export const DELETE = handle(async (req: Request) => json(await setMute(req.headers.get('x-user-id'), await body(req), false)));
