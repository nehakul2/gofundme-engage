import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis, getRedis } from '@/lib/redis';
import { IDS, SLUGS } from '@/fixtures';
import { classify, inCidr, MAX_EVENTS_PER_MINUTE } from '@/lib/botfilter';
import { engagementMetrics, recordPageView } from '@/lib/analytics';
import { recordShare, setFollow } from '@/lib/engagement';
import { newSince, readPulse, toMessages, type PulseEntry } from '@/lib/pulse';
import { okBody, postDonation, resetAll, settle, webhook } from './helpers';

beforeEach(async () => {
  await resetAll();
  delete process.env.INTERNAL_CIDRS;
  delete process.env.INTERNAL_TRAFFIC_KEY;
});
afterAll(async () => { await closePool(); await closeRedis(); });

const UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/605 Safari/605';
const facts = (over: Partial<Parameters<typeof classify>[0]> = {}) => ({ ip: '203.0.113.9', userAgent: UA, internalKey: null, visitorKey: 'v-1', ...over });
const q = async (sql: string, p: unknown[] = []) => (await getPool().query(sql, p)).rows;

describe('bot and internal traffic (ANA-09)', () => {
  it('matches IPv4 CIDR ranges', () => {
    expect(inCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(inCidr('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(inCidr('192.168.1.5', '192.168.1.5')).toBe(true);
    expect(inCidr('not-an-ip', '10.0.0.0/8')).toBe(false);
  });

  it('layer 1: internal network ranges', async () => {
    process.env.INTERNAL_CIDRS = '198.51.100.0/24, 10.0.0.0/8';
    expect(await classify(facts({ ip: '198.51.100.7' }))).toBe('internal_network');
    expect(await classify(facts({ ip: '203.0.113.9' }))).toBeNull();
  });

  it('layer 2: deterministic markers', async () => {
    process.env.INTERNAL_TRAFFIC_KEY = 'letmein';
    expect(await classify(facts({ internalKey: 'letmein' }))).toBe('internal_key');
    expect(await classify(facts({ internalKey: 'wrong' }))).toBeNull();
    expect(await classify(facts({ visitorKey: 'synthetic_check' }))).toBe('synthetic_visitor');
    expect(await classify(facts({ userAgent: 'GoFundMe-Synthetic/1.0 Safari' }))).toBe('synthetic_agent');
  });

  it('layer 3: crawler agents and rapid-fire visitors', async () => {
    expect(await classify(facts({ userAgent: 'Googlebot/2.1' }))).toBe('bot_user_agent');
    expect(await classify(facts({ userAgent: null }))).toBe('bot_user_agent');
    const t = Date.now();
    let last: string | null = null;
    for (let i = 0; i < MAX_EVENTS_PER_MINUTE + 1; i++) last = await classify(facts({ visitorKey: 'fast' }), t);
    expect(last).toBe('rate_limit');
    expect(await classify(facts({ visitorKey: 'calm' }), t)).toBeNull();
  });

  it('flagged page views are stored with a reason and left out of metrics', async () => {
    await recordPageView({ type: 'page_view', path: '/f/x' }, facts({ visitorKey: 'human' }), null);
    const r = await recordPageView({ type: 'page_view', path: '/f/x' }, facts({ visitorKey: 'crawler', userAgent: 'Googlebot' }), null);
    expect(r.counted).toBe(false);
    expect(await q('SELECT count(*)::int n FROM analytics_events')).toEqual([{ n: 2 }]);
    const m = await engagementMetrics(7);
    expect(m.visitors).toBe(1);
    expect(m.excluded_bot_events).toEqual({ bot_user_agent: 1 });
  });

  it('rejects a malformed beacon', async () => {
    await expect(recordPageView({ type: 'page_view', path: 'no-slash' }, facts(), null)).rejects.toMatchObject({ status: 400 });
  });
});

describe('engagement metrics', () => {
  async function view(visitor: string, daysAgo: number) {
    await getPool().query(
      `INSERT INTO analytics_events (type, visitor_key, path, created_at) VALUES ('page_view', $1, '/', now() - $2::int * interval '1 day')`,
      [visitor, daysAgo],
    );
  }

  it('counts repeat visitors and the action rate for repeat vs new visitors', async () => {
    await view('anon-repeat', 0); await view('anon-repeat', 2); // repeat
    await view('anon-new', 0);                                  // new, same day twice is still one day
    await view('anon-new', 0);
    await view('anon-actor', 0); await view('anon-actor', 1);  // repeat, will act
    await recordShare(SLUGS.F1, { channel: 'x' }, { userId: null, anonId: 'anon-actor' });
    await recordShare(SLUGS.F1, { channel: 'x' }, { userId: null, anonId: 'anon-new' });
    await view('anon-old', 30);                                 // outside the 7 day window

    const m = await engagementMetrics(7);
    expect(m).toMatchObject({
      visitors: 3,
      repeat_visitors: 2,
      visitors_who_acted: 2,
      action_rate_repeat_pct: 50,
      action_rate_new_pct: 100,
    });
    expect(m.repeat_visit_rate_pct).toBeCloseTo(66.7, 1);
    expect(m.actions).toEqual({ share: 2 });
  });

  it('records follow once and a donate event when the payment settles', async () => {
    await setFollow(IDS.U2, { target_type: 'fundraiser', target_id: IDS.F1 }, true);
    await setFollow(IDS.U2, { target_type: 'fundraiser', target_id: IDS.F1 }, true); // no change, no event
    const d = await postDonation(SLUGS.F1, okBody(), 'ana-don-key-1', { 'x-anon-id': 'anon-donor' });
    expect(await q("SELECT 1 FROM analytics_events WHERE type = 'donate'")).toHaveLength(0); // pending is not an action yet
    await webhook('payment.succeeded', d.body.id);
    await webhook('payment.succeeded', d.body.id); // replay
    const rows = await q("SELECT type, visitor_key FROM analytics_events WHERE type <> 'page_view' ORDER BY id");
    expect(rows).toEqual([{ type: 'follow', visitor_key: IDS.U2 }, { type: 'donate', visitor_key: 'anon-donor' }]);
  });
});

describe('live pulse', () => {
  const e = (id: string, cents = 100, name: string | null = 'A'): PulseEntry => ({ id, type: 'donation', amount_cents: cents, name, at: 't' });

  it('returns only entries newer than the cursor, oldest first', () => {
    const list = [e('3'), e('2'), e('1')]; // newest first
    expect(newSince(list, '1').map((x) => x.id)).toEqual(['2', '3']);
    expect(newSince(list, '3')).toEqual([]);
    expect(newSince(list, null)).toEqual([]);
    expect(newSince(list, 'gone').map((x) => x.id)).toEqual(['1', '2', '3']); // cursor scrolled off
  });

  it('folds a burst into one summary', () => {
    const burst = Array.from({ length: 8 }, (_, i) => e(String(i), 100));
    expect(toMessages(burst)).toEqual([{ kind: 'summary', count: 8, amount_cents: 800 }]);
    expect(toMessages([e('1', 500, 'Dee')])).toEqual([{ kind: 'donation', amount_cents: 500, name: 'Dee', at: 't' }]);
  });

  it('writes settled donations to the pulse list; anonymous donors have no name', async () => {
    const a = await postDonation(SLUGS.F1, okBody(2500, { display_name: 'Priya' }), 'pulse-key-aaaa');
    const b = await postDonation(SLUGS.F1, okBody(900, { display_name: 'Hidden', is_anonymous: true }), 'pulse-key-bbbb');
    await webhook('payment.succeeded', a.body.id);
    await settle();
    await webhook('payment.succeeded', b.body.id);
    await settle();
    const pulse = await readPulse(IDS.F1);
    expect(pulse.map((p) => [p.amount_cents, p.name])).toEqual([[900, null], [2500, 'Priya']]);
    await getRedis().flushdb();
  });
});
