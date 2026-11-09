import { GET as roomStream } from '@/app/api/v1/fundraisers/[ref]/chat/stream/route';
import { LOBBY_REF } from '@/lib/chat';

export const dynamic = 'force-dynamic';
export const GET = (req: Request) => roomStream(req, { params: Promise.resolve({ ref: LOBBY_REF }) });
