import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis } from '@/lib/redis';
import { IDS, SLUGS } from '@/fixtures';
import { listMessages, postMessage } from '@/lib/chat';
import { resetAll } from './helpers';

beforeEach(resetAll);
afterEach(() => { delete process.env.ADMIN_KEY; });
afterAll(async () => { await closePool(); await closeRedis(); });

function req(method: string, body?: unknown, user: string | null = IDS.U2, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
  if (user) headers['x-user-id'] = user;
  return new Request('http://x/', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const out = async (res: Response) => ({ status: res.status, body: await res.json() });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

const say = async (user: string, body: string, ref = SLUGS.F1) => (await postMessage(ref, user, { body })).message;
const report = async (messageId: string, user: string | null = IDS.U2, body: unknown = {}) => {
  const { POST } = await import('@/app/api/v1/chat/messages/[messageId]/report/route');
  return out(await POST(req('POST', body, user), ctx({ messageId })));
};
const mutes = async (m: 'GET' | 'POST' | 'DELETE', body?: unknown, user: string | null = IDS.U2) => {
  const r = await import('@/app/api/v1/me/mutes/route');
  return out(await r[m](req(m, body, user)));
};
const admin = (key?: string): Record<string, string> => (key ? { 'x-admin-key': key } : {});
const adminReports = async (key?: string) => out(await (await import('@/app/api/v1/admin/reports/route')).GET(req('GET', undefined, null, admin(key))));
const resolve = async (messageId: string, action: string, key?: string) =>
  out(await (await import('@/app/api/v1/admin/reports/[messageId]/route')).POST(req('POST', { action }, null, admin(key)), ctx({ messageId })));
const words = async (m: 'GET' | 'POST' | 'DELETE', body?: unknown, key?: string) =>
  out(await (await import('@/app/api/v1/admin/words/route'))[m](req(m, body, null, admin(key))));

describe('MOD: word filter', () => {
  it('MOD-01 a blocked word stops the message, whatever its capitalisation, and nothing is saved', async () => {
    await words('POST', { word: 'Scam' });
    await expect(postMessage(SLUGS.F1, IDS.U2, { body: 'this is a SCAM, do not give' })).rejects.toMatchObject({ status: 422, code: 'message_blocked' });
    expect((await listMessages(SLUGS.F1)).messages).toHaveLength(0);
  });

  it('MOD-02 only whole words are blocked, so longer words that contain it still go through', async () => {
    await words('POST', { word: 'ass' });
    expect((await say(IDS.U2, 'Our class raised a lot')).body).toBe('Our class raised a lot');
    await expect(postMessage(SLUGS.F1, IDS.U2, { body: 'what an ass.' })).rejects.toMatchObject({ code: 'message_blocked' });
  });

  it('MOD-03 the filter covers the homepage lobby too, and removing the word lifts it', async () => {
    await words('POST', { word: 'spamword' });
    await expect(postMessage('_lobby', IDS.U3, { body: 'buy spamword now' })).rejects.toMatchObject({ code: 'message_blocked' });
    expect(await words('DELETE', { word: 'SPAMWORD' })).toMatchObject({ body: { removed: true } });
    expect((await postMessage('_lobby', IDS.U3, { body: 'buy spamword now' })).message.body).toContain('spamword');
  });

  it('MOD-04 adding a word twice changes nothing, and short or long words are rejected', async () => {
    expect((await words('POST', { word: 'badword' })).body.changed).toBe(true);
    expect((await words('POST', { word: 'BADWORD' })).body.changed).toBe(false);
    expect((await words('GET')).body.words).toEqual(['badword']);
    expect(await words('POST', { word: 'a' })).toMatchObject({ status: 400, body: { error: { field: 'word' } } });
    expect((await words('POST', { word: 'x'.repeat(41) })).status).toBe(400);
  });
});

describe('MOD: reporting a message', () => {
  it('MOD-05 a signed-in user reports someone else’s message; reporting again changes nothing', async () => {
    const m = await say(IDS.U3, 'rude message');
    expect(await report(m.id, IDS.U2, { reason: 'abusive' })).toMatchObject({ status: 200, body: { reported: true, changed: true } });
    expect((await report(m.id, IDS.U2)).body.changed).toBe(false);
    const rows = await getPool().query('SELECT count(*)::int AS n FROM chat_reports WHERE message_id = $1', [m.id]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('MOD-06 guests, unknown users, your own message, removed messages and long reasons are refused', async () => {
    const mine = await say(IDS.U2, 'mine');
    const theirs = await say(IDS.U3, 'theirs');
    expect((await report(theirs.id, null)).status).toBe(401);
    expect((await report(theirs.id, '01930000-0000-7000-8000-0001000000ff')).status).toBe(401);
    expect(await report(mine.id, IDS.U2)).toMatchObject({ status: 422, body: { error: { code: 'cannot_report_own' } } });
    expect((await report('00000000-0000-4000-8000-000000000001', IDS.U2)).status).toBe(404);
    expect((await report('not-an-id', IDS.U2)).status).toBe(404);
    expect(await report(theirs.id, IDS.U2, { reason: 'x'.repeat(201) })).toMatchObject({ status: 400, body: { error: { field: 'reason' } } });
    await getPool().query('UPDATE chat_messages SET deleted_at = now() WHERE id = $1', [theirs.id]);
    expect((await report(theirs.id, IDS.U2)).status).toBe(404);
  });
});

describe('MOD: admin review', () => {
  it('MOD-07 the queue groups reports by message, most reported first', async () => {
    const a = await say(IDS.U3, 'first bad');
    const b = await say(IDS.U3, 'second bad');
    await report(a.id, IDS.U2, { reason: 'spam' });
    await report(b.id, IDS.U2); await report(b.id, IDS.U4, { reason: 'abusive' });
    const q = (await adminReports()).body.reports;
    expect(q.map((r: { message_id: string }) => r.message_id)).toEqual([b.id, a.id]);
    expect(q[0]).toMatchObject({ reports: 2, author: 'Dee Donor', room: 'Wildfire alerts for everyone', reasons: ['abusive'] });
  });

  it('MOD-08 removing a reported message hides it from the room and closes its reports', async () => {
    const m = await say(IDS.U3, 'remove me');
    await report(m.id, IDS.U2);
    expect(await resolve(m.id, 'remove')).toMatchObject({ status: 200, body: { action: 'remove', closed: 1 } });
    expect((await listMessages(SLUGS.F1)).messages).toHaveLength(0);
    expect((await adminReports()).body.reports).toEqual([]);
  });

  it('MOD-09 dismissing keeps the message and closes the reports', async () => {
    const m = await say(IDS.U3, 'keep me');
    await report(m.id, IDS.U2);
    expect(await resolve(m.id, 'dismiss')).toMatchObject({ body: { action: 'dismiss', closed: 1 } });
    expect((await listMessages(SLUGS.F1)).messages).toHaveLength(1);
    expect((await adminReports()).body.reports).toEqual([]);
  });

  it('MOD-10 bad actions and unknown messages are rejected', async () => {
    const m = await say(IDS.U3, 'x');
    expect(await resolve(m.id, 'ban')).toMatchObject({ status: 400, body: { error: { field: 'action' } } });
    expect((await resolve('00000000-0000-4000-8000-000000000001', 'remove')).status).toBe(404);
  });

  it('MOD-11 with ADMIN_KEY set, every admin and metrics endpoint refuses a missing or wrong key', async () => {
    process.env.ADMIN_KEY = 'secret-key';
    const m = await say(IDS.U3, 'x');
    expect((await adminReports()).status).toBe(403);
    expect((await adminReports('wrong')).status).toBe(403);
    expect((await resolve(m.id, 'dismiss', 'wrong')).status).toBe(403);
    expect((await words('GET')).status).toBe(403);
    expect((await words('POST', { word: 'abc' }, 'wrong')).status).toBe(403);
    const { GET } = await import('@/app/api/v1/metrics/engagement/route');
    expect((await out(await GET(req('GET', undefined, null)))).status).toBe(403);
    expect((await out(await GET(req('GET', undefined, null, admin('secret-key'))))).status).toBe(200);
    expect((await adminReports('secret-key')).status).toBe(200);
  });
});

describe('MOD: muting', () => {
  it('MOD-12 muting is per person, repeatable, listed, and can be undone', async () => {
    expect(await mutes('POST', { user_id: IDS.U3 })).toMatchObject({ status: 200, body: { muted: true, changed: true } });
    expect((await mutes('POST', { user_id: IDS.U3 })).body.changed).toBe(false);
    expect((await mutes('GET')).body.muted.map((u: { user_id: string }) => u.user_id)).toEqual([IDS.U3]);
    expect((await mutes('GET', undefined, IDS.U4)).body.muted).toEqual([]);          // someone else's list is separate
    expect(await mutes('DELETE', { user_id: IDS.U3 })).toMatchObject({ body: { muted: false, changed: true } });
    expect((await mutes('GET')).body.muted).toEqual([]);
  });

  it('MOD-13 you cannot mute yourself, guests cannot mute, and bad or unknown people are refused', async () => {
    expect(await mutes('POST', { user_id: IDS.U2 })).toMatchObject({ status: 422, body: { error: { code: 'cannot_mute_self' } } });
    expect((await mutes('POST', { user_id: IDS.U3 }, null)).status).toBe(401);
    expect((await mutes('POST', { user_id: 'nope' })).status).toBe(400);
    expect((await mutes('POST', { user_id: '01930000-0000-7000-8000-0001000000ff' })).status).toBe(404);
  });
});
