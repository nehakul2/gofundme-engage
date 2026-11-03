import { handle, json, ApiError } from '@/lib/errors';
import { addWord, listWords, removeWord, requireAdmin } from '@/lib/moderation';

const body = async (req: Request) => { try { return await req.json(); } catch { throw new ApiError(400, 'validation_failed', 'Body must be valid JSON'); } };

// The words that chat refuses. GET lists, POST { word } adds, DELETE { word } removes.
export const GET = handle(async (req: Request) => { requireAdmin(req); return json({ words: await listWords() }, 200, { 'cache-control': 'private, no-store' }); });
export const POST = handle(async (req: Request) => { requireAdmin(req); return json(await addWord(await body(req))); });
export const DELETE = handle(async (req: Request) => { requireAdmin(req); return json(await removeWord(await body(req))); });
