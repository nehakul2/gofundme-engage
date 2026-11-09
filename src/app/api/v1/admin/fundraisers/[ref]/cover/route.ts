import { handle, json } from '@/lib/errors';
import { requireAdmin } from '@/lib/moderation';
import { adminRemoveCover } from '@/lib/covers';

// DELETE /api/v1/admin/fundraisers/:ref/cover   an admin takes a photo down
export const DELETE = handle(async (req: Request, { params }: { params: Promise<{ ref: string }> }) => {
  requireAdmin(req);
  const { ref } = await params;
  return json(await adminRemoveCover(ref));
});
