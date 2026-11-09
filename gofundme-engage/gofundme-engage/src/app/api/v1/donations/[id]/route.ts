import { handle, json } from '@/lib/errors';
import { getDonation } from '@/lib/donations';

// GET /api/v1/donations/:id   poll a donation's status
export const GET = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return json(await getDonation(id), 200, { 'cache-control': 'private, no-store' });
});
