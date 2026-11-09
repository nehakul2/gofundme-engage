import { relayOnce } from '@/lib/outbox';
import { LocalQueue } from '@/lib/queue';
import { handleMessage } from '@/lib/pipeline';
import { flushDirty } from '@/lib/counters';
import { verifyPending } from '@/lib/verify';
import { closePool } from '@/lib/db';
import { closeRedis } from '@/lib/redis';

// Worker process: relays outbox events, applies counters, flushes stats to Postgres.
// Production swaps LocalQueue for SQS FIFO; the handler code stays the same.
const queue = new LocalQueue();
let stopping = false;
let lastFlush = 0;
let lastVerify = 0;

async function tick() {
  const relayed = await relayOnce(queue);
  const handled = await queue.drain(handleMessage);
  if (Date.now() - lastFlush >= 1000) {
    lastFlush = Date.now();
    await flushDirty(); // batched: roughly one Postgres write per fundraiser per second
  }
  if (Date.now() - lastVerify >= 10 * 60_000) {
    lastVerify = Date.now();
    const v = await verifyPending(); // pending donations older than 24 h
    if (v.checked) console.log('verifyPending', v);
  }
  return relayed + handled;
}

async function main() {
  console.log('worker started');
  while (!stopping) {
    try {
      const busy = await tick();
      if (!busy) await new Promise((r) => setTimeout(r, 200));
    } catch (e) {
      console.error('worker tick failed', e);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await closePool();
  await closeRedis();
}
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => (stopping = true));
main();
