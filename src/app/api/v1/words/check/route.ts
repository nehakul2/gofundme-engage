import { handle, json } from '@/lib/errors';
import { findBlockedWord } from '@/lib/moderation';

// GET /api/v1/words/check?text=...  tells the chat early whether a title or story has a blocked word.
export const GET = handle(async (req: Request) => {
  const text = (new URL(req.url).searchParams.get('text') ?? '').slice(0, 20_000);
  return json({ blocked: text ? await findBlockedWord(text) : null }, 200, { 'cache-control': 'no-store' });
});
