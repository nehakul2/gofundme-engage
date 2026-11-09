import { withTx, type Tx } from './db';
import type { Queue } from './queue';

// Events are written in the same transaction as the change they describe.
export async function emit(
  c: Tx,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await c.query(
    `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [aggregateType, aggregateId, eventType, JSON.stringify(payload)],
  );
}

// Publishes committed events to the queue, oldest first, and marks them published.
// SKIP LOCKED lets several relays run side by side without publishing the same rows.
// If the relay dies after publishing but before commit, the event is published again;
// consumers dedupe on the event id.
export async function relayOnce(queue: Queue, limit = 500): Promise<number> {
  return withTx(async (c) => {
    const { rows } = await c.query(
      `SELECT id, aggregate_id, event_type, payload
         FROM outbox_events
        WHERE published_at IS NULL
        ORDER BY id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    for (const r of rows) {
      // One ordered lane per fundraiser; other lanes run in parallel
      const group = (r.payload.fundraiser_id as string | undefined) ?? r.aggregate_id;
      queue.publish({ id: String(r.id), group, type: r.event_type, payload: r.payload });
    }
    if (rows.length) {
      await c.query('UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::bigint[])', [
        rows.map((r) => r.id),
      ]);
    }
    return rows.length;
  });
}
