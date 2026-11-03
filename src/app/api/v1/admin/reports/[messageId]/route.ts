import { handle, json, ApiError } from '@/lib/errors';
import { requireAdmin, resolveReports } from '@/lib/moderation';

// POST /api/v1/admin/reports/:messageId  { action: "remove" | "dismiss" }
export const POST = handle(async (req: Request, { params }: { params: Promise<{ messageId: string }> }) => {
  requireAdmin(req);
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new ApiError(400, 'validation_failed', 'Body must be valid JSON'); }
  return json(await resolveReports((await params).messageId, raw));
});
