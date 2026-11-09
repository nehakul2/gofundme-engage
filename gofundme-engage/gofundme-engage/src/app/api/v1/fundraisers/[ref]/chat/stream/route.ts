import { errorResponse } from '@/lib/errors';
import { changesSince, chatSeq, latestMessageId, resolveChatRoom } from '@/lib/chat';

export const dynamic = 'force-dynamic';

// GET /api/v1/fundraisers/:ref/chat/stream   Server-Sent Events: "message" and "removed".
// Once a second it compares a Redis counter; Postgres is queried only when the counter moved
// (and on a 15 s safety timer, in case Redis lost the counter).
export async function GET(req: Request, { params }: { params: Promise<{ ref: string }> }) {
  try {
    const f = await resolveChatRoom((await params).ref);
    const enc = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) =>
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        let cursor = await latestMessageId(f.id);
        let seq = await chatSeq(f.id);
        let lastLook = Date.now();
        // "ready" tells the page to fetch anything it missed since its history was loaded
        send('ready', {});
        const close = () => { clearInterval(timer); try { controller.close(); } catch { /* already closed */ } };
        req.signal.addEventListener('abort', close);
        let beats = 0;
        timer = setInterval(async () => {
          try {
            beats++;
            const now = await chatSeq(f.id);
            if (now !== seq || beats % 15 === 0) {
              seq = now;
              const { added, removed } = await changesSince(f.id, f.owner_id, cursor, lastLook - 3000);
              lastLook = Date.now();
              for (const m of added) { send('message', m); cursor = m.id; }
              if (removed.length) send('removed', { ids: removed });
              if (!added.length && !removed.length) controller.enqueue(enc.encode(': keepalive\n\n'));
            }
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
