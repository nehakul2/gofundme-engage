import { handle, json } from '@/lib/errors';
import { reportMessage } from '@/lib/moderation';

// POST /api/v1/chat/messages/:messageId/report  { reason? }   signed-in users; reporting twice changes nothing
export const POST = handle(async (req: Request, { params }: { params: Promise<{ messageId: string }> }) => {
  const raw = await req.json().catch(() => ({}));
  return json(await reportMessage(req.headers.get('x-user-id'), (await params).messageId, raw));
});
