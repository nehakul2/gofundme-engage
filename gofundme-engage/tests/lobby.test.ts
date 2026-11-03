import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis } from '@/lib/redis';
import { IDS, SLUGS } from '@/fixtures';
import { deleteMessage, listMessages, LOBBY_REF, postMessage } from '@/lib/chat';
import { resetAll } from './helpers';

beforeEach(resetAll);
afterAll(async () => { await closePool(); await closeRedis(); });

const say = (text: string, user: string | null = IDS.U2) => postMessage(LOBBY_REF, user, { body: text });

describe('LOBBY: the homepage chat room', () => {
  it('LOBBY-01 signed-in users post, guests read', async () => {
    await say('Looking for wildfire causes');
    await say('Try Wildfire alerts', IDS.U3);
    const { messages } = await listMessages(LOBBY_REF);
    expect(messages.map((m) => [m.user.display_name, m.body, m.is_organizer])).toEqual([
      ['Dan Donor', 'Looking for wildfire causes', false],
      ['Dee Donor', 'Try Wildfire alerts', false],
    ]);
    await expect(say('hi', null)).rejects.toMatchObject({ status: 401 });
  });

  it('LOBBY-02 the lobby and fundraiser rooms never mix', async () => {
    await say('lobby only');
    await postMessage(SLUGS.F1, IDS.U2, { body: 'fundraiser only' });
    expect((await listMessages(LOBBY_REF)).messages.map((m) => m.body)).toEqual(['lobby only']);
    expect((await listMessages(SLUGS.F1)).messages.map((m) => m.body)).toEqual(['fundraiser only']);
  });

  it('LOBBY-03 only the author removes a lobby message; a fundraiser organizer has no power here', async () => {
    const { message } = await say('mine');
    await expect(deleteMessage(LOBBY_REF, message.id, IDS.U3)).rejects.toMatchObject({ status: 403 });
    await expect(deleteMessage(LOBBY_REF, message.id, IDS.U1)).rejects.toMatchObject({ status: 403 });
    await deleteMessage(LOBBY_REF, message.id, IDS.U2);
    expect((await listMessages(LOBBY_REF)).messages).toHaveLength(0);
  });

  it('LOBBY-04 the same rules apply: validation, no organizer badge', async () => {
    await expect(say('   ')).rejects.toMatchObject({ status: 400 });
    expect((await say('x'.repeat(500))).message.is_organizer).toBe(false);
    await expect(say('x'.repeat(501))).rejects.toMatchObject({ status: 400 });
  });

  it('LOBBY-05 the HTTP routes work', async () => {
    const { GET, POST } = await import('@/app/api/v1/lobby/chat/route');
    const { DELETE } = await import('@/app/api/v1/lobby/chat/[messageId]/route');
    const h = { 'x-user-id': IDS.U2, 'content-type': 'application/json' };
    const posted = await POST(new Request('http://x/', { method: 'POST', headers: h, body: JSON.stringify({ body: 'hello lobby' }) }));
    expect(posted.status).toBe(201);
    const msg = await posted.json();
    expect((await (await GET(new Request('http://x/'))).json()).messages).toHaveLength(1);
    const del = await DELETE(new Request('http://x/', { method: 'DELETE', headers: h }), { params: Promise.resolve({ messageId: msg.id }) });
    expect(del.status).toBe(204);
  });

  it('LOBBY-06 lobby rows are stored under the fixed room id and survive without a fundraiser', async () => {
    await say('stored');
    const { rows } = await getPool().query('SELECT fundraiser_id FROM chat_messages');
    expect(rows[0].fundraiser_id).toBe('00000000-0000-4000-8000-00000000100b');
  });
});
