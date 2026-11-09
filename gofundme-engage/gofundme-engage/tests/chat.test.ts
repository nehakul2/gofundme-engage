import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis, getRedis } from '@/lib/redis';
import { IDS, SLUGS } from '@/fixtures';
import { changesSince, chatSeq, cleanBody, deleteMessage, listMessages, MAX_BODY, postMessage, RATE_LIMIT } from '@/lib/chat';
import { resetAll } from './helpers';

beforeEach(resetAll);
afterAll(async () => { await closePool(); await closeRedis(); });

const say = (text: string, user: string | null = IDS.U2, extra: Record<string, unknown> = {}, ref: string = SLUGS.F1) =>
  postMessage(ref, user, { body: text, ...extra });

describe('CHAT: posting', () => {
  it('CHAT-01 a signed-in user posts and everyone can read it, with the organizer marked', async () => {
    await say('Hello from Dan');
    await say('Thanks for coming, Dan', IDS.U1);
    const { messages, has_more } = await listMessages(SLUGS.F1);
    expect(has_more).toBe(false);
    expect(messages.map((m) => [m.user.display_name, m.is_organizer, m.body])).toEqual([
      ['Dan Donor', false, 'Hello from Dan'],
      ['Olivia Owner', true, 'Thanks for coming, Dan'],
    ]);
  });

  it('CHAT-02 guests and unknown users cannot post', async () => {
    await expect(say('hi', null)).rejects.toMatchObject({ status: 401 });
    await expect(say('hi', '01930000-0000-7000-8000-0001000000ff')).rejects.toMatchObject({ status: 401 });
  });

  it('CHAT-03 empty, blank and over-long messages are rejected', async () => {
    for (const body of ['', '   ', '\n\n']) await expect(say(body)).rejects.toMatchObject({ status: 400, field: 'body' });
    await expect(say('x'.repeat(MAX_BODY + 1))).rejects.toMatchObject({ status: 400 });
    await expect(postMessage(SLUGS.F1, IDS.U2, { nope: 1 })).rejects.toMatchObject({ status: 400 });
    expect((await say('x'.repeat(MAX_BODY))).message.body).toHaveLength(MAX_BODY);
  });

  it('CHAT-04 control characters are stripped and blank-line runs collapse', () => {
    expect(cleanBody('  a\u0000b\u0007c\r\n\r\n\r\n\r\nd  ')).toBe('abc\n\nd');
  });

  it('CHAT-05 HTML is stored as plain text, never interpreted', async () => {
    const { message } = await say('<script>alert(1)</script>');
    expect(message.body).toBe('<script>alert(1)</script>');   // the page renders text nodes only
  });

  it('CHAT-06 a retried send with the same client_id returns the first message once', async () => {
    const a = await say('only once', IDS.U2, { client_id: 'c-1' });
    const b = await say('only once', IDS.U2, { client_id: 'c-1' });
    expect(a.replay).toBe(false);
    expect(b).toMatchObject({ replay: true, message: { id: a.message.id } });
    expect((await getPool().query('SELECT count(*)::int n FROM chat_messages')).rows[0].n).toBe(1);
  });

  it('CHAT-07 ten parallel sends with one client_id make exactly one message', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => say('race', IDS.U2, { client_id: 'c-race' }).catch((e) => e)));
    const ids = new Set(rs.filter((r) => 'message' in r).map((r) => r.message.id));
    expect(ids.size).toBe(1);
    expect((await getPool().query('SELECT count(*)::int n FROM chat_messages')).rows[0].n).toBe(1);
  });

  it('CHAT-08 rate limit: the sixth message in the window is refused with Retry-After', async () => {
    for (let i = 0; i < RATE_LIMIT; i++) await say(`m${i}`);
    const err = await say('too many').catch((e) => e);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(Number(err.headers['retry-after'])).toBeGreaterThan(0);
    await say('another person is fine', IDS.U3);               // the limit is per user
    await getRedis().flushdb();                                 // window passes
    await expect(say('back again')).resolves.toBeTruthy();
  });

  it('CHAT-09 chat is closed on ended fundraisers (still readable) and gone on removed ones', async () => {
    await expect(say('late', IDS.U2, {}, SLUGS.F3)).rejects.toMatchObject({ status: 409, code: 'chat_closed' });
    expect((await listMessages(SLUGS.F3)).messages).toEqual([]);
    await expect(say('x', IDS.U2, {}, SLUGS.F4)).rejects.toMatchObject({ status: 410 });
    await expect(listMessages(SLUGS.F4)).rejects.toMatchObject({ status: 410 });
    await expect(listMessages('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('CHAT-10 rooms are separate: a message in one fundraiser never shows in another', async () => {
    await say('in F1');
    await say('in F2', IDS.U2, {}, SLUGS.F2);
    expect((await listMessages(SLUGS.F1)).messages.map((m) => m.body)).toEqual(['in F1']);
    expect((await listMessages(SLUGS.F2)).messages.map((m) => m.body)).toEqual(['in F2']);
  });
});

describe('CHAT: reading and removing', () => {
  it('CHAT-11 pages backwards with before, oldest first, and says when there is more', async () => {
    for (let i = 1; i <= 7; i++) await say(`m${i}`, i % 2 ? IDS.U2 : IDS.U3);
    const latest = await listMessages(SLUGS.F1, { limit: 3 });
    expect(latest.messages.map((m) => m.body)).toEqual(['m5', 'm6', 'm7']);
    expect(latest.has_more).toBe(true);
    const older = await listMessages(SLUGS.F1, { limit: 3, before: latest.messages[0].id });
    expect(older.messages.map((m) => m.body)).toEqual(['m2', 'm3', 'm4']);
    const oldest = await listMessages(SLUGS.F1, { limit: 3, before: older.messages[0].id });
    expect(oldest).toMatchObject({ messages: [{ body: 'm1' }], has_more: false });
  });

  it('CHAT-12 after returns only newer messages; bad ids are rejected', async () => {
    const a = await say('first');
    await say('second');
    expect((await listMessages(SLUGS.F1, { after: a.message.id })).messages.map((m) => m.body)).toEqual(['second']);
    await expect(listMessages(SLUGS.F1, { after: 'nope' })).rejects.toMatchObject({ status: 400 });
    await expect(listMessages(SLUGS.F1, { before: 'nope' })).rejects.toMatchObject({ status: 400 });
  });

  it('CHAT-13 the author and the organizer can remove a message; nobody else can', async () => {
    const m = (await say('mine')).message;
    await expect(deleteMessage(SLUGS.F1, m.id, IDS.U3)).rejects.toMatchObject({ status: 403 });
    await expect(deleteMessage(SLUGS.F1, m.id, null)).rejects.toMatchObject({ status: 401 });
    await deleteMessage(SLUGS.F1, m.id, IDS.U2);
    expect((await listMessages(SLUGS.F1)).messages).toEqual([]);

    const n = (await say('rude message', IDS.U3)).message;
    await deleteMessage(SLUGS.F1, n.id, IDS.U1);                 // organizer moderates
    expect((await listMessages(SLUGS.F1)).messages).toEqual([]);
    const row = (await getPool().query('SELECT deleted_by, body FROM chat_messages WHERE id = $1', [n.id])).rows[0];
    expect(row).toMatchObject({ deleted_by: IDS.U1, body: 'rude message' });   // kept for audit
  });

  it('CHAT-14 removing twice is fine; unknown and cross-room ids are 404', async () => {
    const m = (await say('bye')).message;
    await deleteMessage(SLUGS.F1, m.id, IDS.U2);
    await expect(deleteMessage(SLUGS.F1, m.id, IDS.U2)).resolves.toBeUndefined();
    await expect(deleteMessage(SLUGS.F2, m.id, IDS.U2)).rejects.toMatchObject({ status: 404 });
    await expect(deleteMessage(SLUGS.F1, 'not-a-uuid', IDS.U2)).rejects.toMatchObject({ status: 404 });
  });

  it('CHAT-15 after a message is removed, the same client_id posts a new message (the old one stays gone)', async () => {
    const m = (await say('v1', IDS.U2, { client_id: 'c-x' })).message;
    await deleteMessage(SLUGS.F1, m.id, IDS.U2);
    const again = await say('v2', IDS.U2, { client_id: 'c-x' });
    expect(again.replay).toBe(false);
    expect(again.message.id).not.toBe(m.id);
    expect((await listMessages(SLUGS.F1)).messages.map((x) => x.body)).toEqual(['v2']);
  });
});

describe('CHAT: live changes', () => {
  it('CHAT-16 the counter moves on post and delete, and changesSince reports both', async () => {
    const before = await chatSeq(IDS.F1);
    const a = (await say('one')).message;
    const mid = await chatSeq(IDS.F1);
    expect(mid).not.toBe(before);
    const t0 = Date.now() - 1000;
    const b = (await say('two')).message;
    await deleteMessage(SLUGS.F1, a.id, IDS.U2);
    expect(await chatSeq(IDS.F1)).not.toBe(mid);
    const ch = await changesSince(IDS.F1, IDS.U1, a.id, t0);
    expect(ch.added.map((m) => m.id)).toEqual([b.id]);
    expect(ch.removed).toEqual([a.id]);
  });

  it('CHAT-17 the HTTP routes work end to end', async () => {
    const { GET, POST } = await import('@/app/api/v1/fundraisers/[ref]/chat/route');
    const { DELETE } = await import('@/app/api/v1/fundraisers/[ref]/chat/[messageId]/route');
    const ctx = { params: Promise.resolve({ ref: SLUGS.F1 }) };
    const noAuth = await POST(new Request('http://x/', { method: 'POST', body: JSON.stringify({ body: 'hi' }) }), ctx);
    expect(noAuth.status).toBe(401);
    const created = await POST(new Request('http://x/', { method: 'POST', headers: { 'x-user-id': IDS.U2 }, body: JSON.stringify({ body: 'hi' }) }), ctx);
    expect(created.status).toBe(201);
    const msg = await created.json();
    const list = await GET(new Request('http://x/api/v1/fundraisers/x/chat?limit=10'), ctx);
    expect((await list.json()).messages[0].id).toBe(msg.id);
    const del = await DELETE(new Request('http://x/', { method: 'DELETE', headers: { 'x-user-id': IDS.U2 } }), { params: Promise.resolve({ ref: SLUGS.F1, messageId: msg.id }) });
    expect(del.status).toBe(204);
  });
});
