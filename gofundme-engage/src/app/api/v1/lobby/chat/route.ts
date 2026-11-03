import { GET as roomGet, POST as roomPost } from '@/app/api/v1/fundraisers/[ref]/chat/route';
import { LOBBY_REF } from '@/lib/chat';

// The homepage lobby chat. Same behaviour as a fundraiser's chat, with a fixed room.
const ctx = { params: Promise.resolve({ ref: LOBBY_REF }) };
export const GET = (req: Request) => roomGet(req, ctx);
export const POST = (req: Request) => roomPost(req, ctx);
