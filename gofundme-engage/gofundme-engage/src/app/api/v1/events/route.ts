import { handle, ApiError } from '@/lib/errors';
import { recordPageView } from '@/lib/analytics';

// POST /api/v1/events   page-view beacon. 204 whether or not the event was counted.
export const POST = handle(async (req: Request) => {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new ApiError(400, 'validation_failed', 'Body must be valid JSON'); }
  const userId = req.headers.get('x-user-id');
  const visitorKey = userId ?? req.headers.get('x-anon-id');
  if (!visitorKey) throw new ApiError(400, 'validation_failed', 'Send x-user-id or x-anon-id', 'x-anon-id');
  await recordPageView(
    raw,
    {
      visitorKey,
      ip: (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null,
      userAgent: req.headers.get('user-agent'),
      internalKey: req.headers.get('x-internal-traffic'),
    },
    userId,
  );
  return new Response(null, { status: 204 });
});
