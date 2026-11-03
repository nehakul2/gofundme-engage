import { DELETE as roomDelete } from '@/app/api/v1/fundraisers/[ref]/chat/[messageId]/route';
import { LOBBY_REF } from '@/lib/chat';

export const DELETE = (req: Request, { params }: { params: Promise<{ messageId: string }> }) =>
  params.then(({ messageId }) => roomDelete(req, { params: Promise.resolve({ ref: LOBBY_REF, messageId }) }));
