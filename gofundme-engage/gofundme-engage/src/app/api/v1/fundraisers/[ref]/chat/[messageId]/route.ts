import { handle } from '@/lib/errors';
import { deleteMessage } from '@/lib/chat';

// DELETE /api/v1/fundraisers/:ref/chat/:messageId   author or organizer; 204 even if already removed
export const DELETE = handle(async (req: Request, { params }: { params: Promise<{ ref: string; messageId: string }> }) => {
  const { ref, messageId } = await params;
  await deleteMessage(ref, messageId, req.headers.get('x-user-id'));
  return new Response(null, { status: 204 });
});
