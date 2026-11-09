import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis, getRedis, keys } from '@/lib/redis';
import { IDS, SLUGS, GOAL_CENTS } from '@/fixtures';
import { setFollow } from '@/lib/engagement';
import { addWord } from '@/lib/moderation';
import { deliverUpdate, getTimeline, postUpdate, UPDATE_LIMIT } from '@/lib/updates';
import { listNotifications, unreadCount } from '@/lib/notifications';
import { getCommunityPage, getFundraiserPage } from '@/lib/read';
import { okBody, postDonation, resetAll, settle, webhook } from './helpers';

beforeEach(resetAll);
afterAll(async () => { await closePool(); await closeRedis(); });

const q = async (sql: string, p: unknown[] = []) => (await getPool().query(sql, p)).rows;
const follow = (u: string, f: string) => setFollow(u, { target_type: 'fundraiser', target_id: f }, true);
let n = 0;
async function donateAs(user: string, fr: string, cents = 2500) {
  const r = await postDonation(fr, okBody(cents), `upd-key-${++n}-${Date.now()}-zzzz`, { 'x-user-id': user });
  await webhook('payment.succeeded', r.body.id);
}

describe('UPD: organizer updates', () => {
  it('UPD-01 the organizer posts an update and gets it back; an outbox event is written', async () => {
    const { update, replay } = await postUpdate(SLUGS.F1, IDS.U1, { body: '  Water tanks are on their way.  ' });
    expect(replay).toBe(false);
    expect(update).toMatchObject({ body: 'Water tanks are on their way.' });
    expect(update.author_handle).toBeTruthy();
    const ev = await q("SELECT payload FROM outbox_events WHERE event_type = 'update.posted'");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ fundraiser_id: IDS.F1, update_id: update.id });
  });

  it('UPD-02 only the organizer can post: guests get 401, other people 403', async () => {
    await expect(postUpdate(SLUGS.F1, null, { body: 'hi there' })).rejects.toMatchObject({ status: 401 });
    await expect(postUpdate(SLUGS.F1, IDS.U2, { body: 'hi there' })).rejects.toMatchObject({ status: 403 });
    expect(await q('SELECT 1 FROM fundraiser_updates')).toHaveLength(0);
  });

  it('UPD-03 empty and over-long updates are rejected; unknown fields too', async () => {
    await expect(postUpdate(SLUGS.F1, IDS.U1, { body: '   ' })).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    await expect(postUpdate(SLUGS.F1, IDS.U1, { body: 'x'.repeat(2001) })).rejects.toMatchObject({ status: 400 });
    await expect(postUpdate(SLUGS.F1, IDS.U1, { body: 'ok', extra: 1 })).rejects.toMatchObject({ status: 400 });
  });

  it('UPD-04 a removed fundraiser takes no updates; an ended one still can (to say thank you)', async () => {
    await expect(postUpdate(SLUGS.F4, IDS.U1, { body: 'hello again' })).rejects.toMatchObject({ status: 410 });
    const { update } = await postUpdate(SLUGS.F3, IDS.U1, { body: 'Thank you all. We finished.' });
    expect(update.body).toContain('Thank you');
  });

  it('UPD-05 the blocked-word list applies and names the word', async () => {
    await addWord({ word: 'haters' });
    await expect(postUpdate(SLUGS.F1, IDS.U1, { body: 'No room for Haters here' })).rejects.toMatchObject({ status: 422, code: 'text_blocked', field: 'update' });
    expect(await q('SELECT 1 FROM fundraiser_updates')).toHaveLength(0);
  });

  it('UPD-06 a retry with the same client_id returns the same update and posts once', async () => {
    const a = await postUpdate(SLUGS.F1, IDS.U1, { body: 'First post', client_id: 'client-abc-123' });
    const b = await postUpdate(SLUGS.F1, IDS.U1, { body: 'First post', client_id: 'client-abc-123' });
    expect(b.replay).toBe(true);
    expect(b.update.id).toBe(a.update.id);
    expect(await q('SELECT 1 FROM fundraiser_updates')).toHaveLength(1);
    expect(await q("SELECT 1 FROM outbox_events WHERE event_type = 'update.posted'")).toHaveLength(1);
  });

  it('UPD-07 more than the hourly limit gets 429 with Retry-After', async () => {
    for (let i = 0; i < UPDATE_LIMIT; i++) await postUpdate(SLUGS.F1, IDS.U1, { body: `Update ${i}` });
    await expect(postUpdate(SLUGS.F1, IDS.U1, { body: 'one too many' })).rejects.toMatchObject({ status: 429, code: 'rate_limited', headers: { 'retry-after': '3600' } });
  });

  it('UPD-08 followers and signed-in donors are notified once; the author and strangers are not', async () => {
    await follow(IDS.U2, IDS.F1);
    await donateAs(IDS.U3, IDS.F1);
    await settle();
    const { update } = await postUpdate(SLUGS.F1, IDS.U1, { body: 'We reached the county line today.' });
    await settle();

    expect(await unreadCount(IDS.U2)).toBe(1);
    expect(await unreadCount(IDS.U3)).toBe(1);
    expect(await unreadCount(IDS.U1)).toBe(0);
    expect(await unreadCount(IDS.U4)).toBe(0);
    const [note] = await listNotifications(IDS.U2);
    expect(note).toMatchObject({ type: 'update', target_id: IDS.F1, slug: SLUGS.F1, read: false });
    expect(note.excerpt).toContain('county line');
    expect(update.id).toBeTruthy();
  });

  it('UPD-09 a follower who also donated gets one notification, and a redelivered event adds nothing', async () => {
    await follow(IDS.U2, IDS.F1);
    await donateAs(IDS.U2, IDS.F1);
    await settle();
    const { update } = await postUpdate(SLUGS.F1, IDS.U1, { body: 'Only one ping please.' });
    await settle();
    expect(await unreadCount(IDS.U2)).toBe(1);
    const again = await deliverUpdate({ fundraiser_id: IDS.F1, update_id: update.id });
    expect(again).toEqual({ posts: 0, notified: 0 });
    expect((await q("SELECT 1 FROM notifications WHERE type = 'update'"))).toHaveLength(1);
    expect(Number(await getRedis().get(keys.unread(IDS.U2)))).toBe(1);
  });

  it('UPD-10 the update also appears in the feed of every community the fundraiser is in', async () => {
    await postUpdate(SLUGS.F1, IDS.U1, { body: 'Community, we are live.' });
    await settle();
    const c = await getCommunityPage(SLUGS.C1);
    const post = c.posts.find((p) => p.kind === 'update');
    expect(post).toMatchObject({ body: 'Community, we are live.', fundraiser_slug: SLUGS.F1 });
    expect((await getCommunityPage(SLUGS.C2)).posts.some((p) => p.kind === 'update')).toBe(false);
  });

  it('UPD-11 the timeline puts updates and milestones together, newest first', async () => {
    await donateAs(IDS.U2, IDS.F2, 1_000); // F2 is 1,000 cents short, so this reaches 100%
    await settle();
    await postUpdate(SLUGS.F2, IDS.U1, { body: 'We did it.' });
    const t = await getTimeline(SLUGS.F2);
    expect(t[0]).toMatchObject({ kind: 'update', body: 'We did it.' });
    expect(t.filter((x) => x.kind === 'milestone').map((x) => (x as { pct: number }).pct)).toEqual([100, 75, 50, 25]);
    const page = await getFundraiserPage(SLUGS.F2);
    expect(page.timeline[0]).toMatchObject({ kind: 'update' });
  });

  it('UPD-12 the update API route: POST needs the organizer, GET is public', async () => {
    const { POST, GET } = await import('@/app/api/v1/fundraisers/[ref]/updates/route');
    const ctx = { params: Promise.resolve({ ref: SLUGS.F1 }) };
    const mk = (headers: Record<string, string>, body: unknown) => new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    expect((await POST(mk({}, { body: 'nope' }), ctx)).status).toBe(401);
    expect((await POST(mk({ 'x-user-id': IDS.U2 }, { body: 'nope' }), ctx)).status).toBe(403);
    const ok = await POST(mk({ 'x-user-id': IDS.U1 }, { body: 'From the route' }), ctx);
    expect(ok.status).toBe(201);
    const list = await (await GET(new Request('http://x/'), ctx)).json();
    expect(list.items[0]).toMatchObject({ kind: 'update', body: 'From the route' });
  });

  it('UPD-13 a notification-driven visit is counted separately in the metrics', async () => {
    const { recordPageView, engagementMetrics } = await import('@/lib/analytics');
    const facts = { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 Safari/605', internalKey: null, visitorKey: 'bell-visitor' };
    await recordPageView({ type: 'page_view', path: '/f/wildfire-alerts', source: 'notification' }, facts, null);
    await recordPageView({ type: 'page_view', path: '/f/wildfire-alerts' }, { ...facts, visitorKey: 'plain-visitor' }, null);
    const m = await engagementMetrics(7);
    expect(m).toMatchObject({ notification_visits: 1, notification_visitors: 1, visitors: 2 });
    await expect(recordPageView({ type: 'page_view', path: '/x', source: 'email' }, facts, null)).rejects.toMatchObject({ status: 400 });
  });
});
