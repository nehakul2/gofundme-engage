import { ApiError, errorResponse } from '@/lib/errors';
import { resolveFundraiser } from '@/lib/stats';
import { newSince, readPulse, toMessages } from '@/lib/pulse';

export const dynamic = 'force-dynamic';

// GET /api/v1/fundraisers/:ref/pulse   Server-Sent Events, one message per new donation
export async function GET(req: Request, { params }: { params: Promise<{ ref: string }> }) {
  try {
    const f = await resolveFundraiser((await params).ref);
    if (f.status === 'removed') throw new ApiError(410, 'gone', 'This fundraiser has been removed');

    const enc = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) =>
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        let cursor: string | null = (await readPulse(f.id))[0]?.id ?? '';
        send('ready', {});
        const close = () => { clearInterval(timer); try { controller.close(); } catch { /* already closed */ } };
        req.signal.addEventListener('abort', close);
        let beats = 0;
        timer = setInterval(async () => {
          try {
            const entries = await readPulse(f.id);
            const fresh = newSince(entries, cursor);
            if (fresh.length) cursor = entries[0].id;
            for (const m of toMessages(fresh)) send('pulse', m);
            if (++beats % 15 === 0) controller.enqueue(enc.encode(': keepalive\n\n'));
          } catch { close(); }
        }, 1000);
      },
      cancel() { clearInterval(timer); },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
