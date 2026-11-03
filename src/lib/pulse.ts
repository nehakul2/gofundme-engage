import { getRedis, keys } from './redis';

// Live pulse: a short list of recent donation events per fundraiser (newest first),
// streamed to the page over SSE. Share and follow events never appear, and
// anonymous donors have no name.
export interface PulseEntry { id: string; type: 'donation'; amount_cents: number; name: string | null; at: string }
export type PulseMessage =
  | { kind: 'donation'; amount_cents: number; name: string | null; at: string }
  | { kind: 'summary'; count: number; amount_cents: number };

// More than this many new entries in one tick are folded into a single summary line.
export const BURST_LIMIT = 5;

export async function readPulse(fundraiserId: string): Promise<PulseEntry[]> {
  const raw = await getRedis().lrange(keys.pulse(fundraiserId), 0, 19);
  return raw.flatMap((r) => { try { return [JSON.parse(r) as PulseEntry]; } catch { return []; } });
}

// Entries newer than the cursor, oldest first. A cursor that has scrolled off the list
// means everything is new.
export function newSince(entries: PulseEntry[], cursor: string | null): PulseEntry[] {
  if (cursor === null) return [];
  const i = entries.findIndex((e) => e.id === cursor);
  const fresh = i === -1 ? entries : entries.slice(0, i);
  return fresh.slice().reverse();
}

export function toMessages(fresh: PulseEntry[]): PulseMessage[] {
  if (fresh.length > BURST_LIMIT) {
    return [{ kind: 'summary', count: fresh.length, amount_cents: fresh.reduce((s, e) => s + e.amount_cents, 0) }];
  }
  return fresh.map((e) => ({ kind: 'donation', amount_cents: e.amount_cents, name: e.name, at: e.at }));
}
