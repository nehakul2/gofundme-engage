import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis, getRedis, keys } from '@/lib/redis';
import { IDS } from '@/fixtures';
import { uuidv7 } from '@/lib/ids';
import { listNotifications, markRead, unreadCount } from '@/lib/notifications';
import { resetAll } from './helpers';

beforeEach(resetAll);
afterAll(async () => { await closePool(); await closeRedis(); });

async function notify(user: string, pct: number, title = 'Wildfire alerts for everyone') {
  const id = uuidv7();
  await getPool().query(
    `INSERT INTO notifications (id, user_id, type, target_type, target_id, payload, dedupe_key)
     VALUES ($1,$2,'milestone','fundraiser',$3,$4,$5)`,
    [id, user, IDS.F1, JSON.stringify({ threshold_pct: pct, raised_cents: pct * 50_000, donor_count: pct, title }), `${user}:${IDS.F1}:${pct}`],
  );
  return id;
}

describe('NOTE: the bell and inbox', () => {
  it('NOTE-01 unread count is per user and starts at zero', async () => {
    expect(await unreadCount(IDS.U2)).toBe(0);
    await notify(IDS.U2, 25); await notify(IDS.U2, 50); await notify(IDS.U3, 25);
    expect(await unreadCount(IDS.U2)).toBe(2);
    expect(await unreadCount(IDS.U3)).toBe(1);
  });

  it('NOTE-02 guests have no inbox', async () => {
    await expect(unreadCount(null)).rejects.toMatchObject({ status: 401 });
    await expect(listNotifications(null)).rejects.toMatchObject({ status: 401 });
    await expect(markRead(null, { all: true })).rejects.toMatchObject({ status: 401 });
  });

  it('NOTE-03 the inbox lists newest first with milestone details and never shows other people\'s', async () => {
    await notify(IDS.U2, 25); await notify(IDS.U2, 50); await notify(IDS.U3, 75);
    const items = await listNotifications(IDS.U2);
    expect(items.map((i) => i.threshold_pct)).toEqual([50, 25]);
    expect(items[0]).toMatchObject({ type: 'milestone', target_id: IDS.F1, title: 'Wildfire alerts for everyone', raised_cents: 2_500_000, donor_count: 50, read: false });
  });

  it('NOTE-04 mark all read clears the badge and resets the Redis counter', async () => {
    await notify(IDS.U2, 25); await notify(IDS.U2, 50);
    await getRedis().set(keys.unread(IDS.U2), '2');
    expect(await markRead(IDS.U2, { all: true })).toEqual({ marked: 2 });
    expect(await unreadCount(IDS.U2)).toBe(0);
    expect(await getRedis().get(keys.unread(IDS.U2))).toBeNull();
    expect((await listNotifications(IDS.U2)).every((i) => i.read)).toBe(true);
    expect(await markRead(IDS.U2, { all: true })).toEqual({ marked: 0 });   // repeat is harmless
  });

  it('NOTE-05 mark some read by id; ids belonging to someone else are ignored', async () => {
    const a = await notify(IDS.U2, 25); await notify(IDS.U2, 50);
    const theirs = await notify(IDS.U3, 25);
    expect(await markRead(IDS.U2, { ids: [a, theirs] })).toEqual({ marked: 1 });
    expect(await unreadCount(IDS.U2)).toBe(1);
    expect(await unreadCount(IDS.U3)).toBe(1);
  });

  it('NOTE-06 bad bodies are rejected', async () => {
    for (const bad of [{}, { ids: [] }, { ids: ['nope'] }, { all: false }, 'x', null]) {
      await expect(markRead(IDS.U2, bad)).rejects.toMatchObject({ status: 400 });
    }
  });

  it('NOTE-07 the HTTP routes work and are never cached', async () => {
    await notify(IDS.U2, 25);
    const { GET: count } = await import('@/app/api/v1/me/notifications/unread-count/route');
    const { GET: list } = await import('@/app/api/v1/me/notifications/route');
    const { POST: read } = await import('@/app/api/v1/me/notifications/read/route');
    const h = { 'x-user-id': IDS.U2 };
    const c = await count(new Request('http://x/', { headers: h }));
    expect(c.headers.get('cache-control')).toContain('no-store');
    expect((await c.json()).unread_count).toBe(1);
    expect((await (await list(new Request('http://x/', { headers: h }))).json()).items).toHaveLength(1);
    expect((await count(new Request('http://x/'))).status).toBe(401);
    expect((await read(new Request('http://x/', { method: 'POST', headers: h, body: JSON.stringify({ all: true }) }))).status).toBe(200);
    expect((await (await count(new Request('http://x/', { headers: h }))).json()).unread_count).toBe(0);
  });
});
