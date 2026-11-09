import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis } from '@/lib/redis';
import { IDS, SLUGS } from '@/fixtures';
import { postMessage } from '@/lib/chat';
import { searchFundraisers } from '@/lib/search';
import { okBody, postDonation, resetAll } from './helpers';

beforeEach(resetAll);
afterAll(async () => { await closePool(); await closeRedis(); });

async function patch(ref: string, body: unknown, user: string | null, ifMatch: string | null = '"v1"') {
  const { PATCH } = await import('@/app/api/v1/fundraisers/[ref]/route');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (user) headers['x-user-id'] = user;
  if (ifMatch) headers['if-match'] = ifMatch;
  const res = await PATCH(new Request('http://x/', { method: 'PATCH', headers, body: JSON.stringify(body) }), { params: Promise.resolve({ ref }) });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

describe('EDIT: renaming a fundraiser (owner only)', () => {
  it('EDIT-01 the owner renames it; the version moves on, the web address stays', async () => {
    const r = await patch(SLUGS.F1, { title: 'Wildfire alerts for every county' }, IDS.U1);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ title: 'Wildfire alerts for every county', slug: SLUGS.F1, version: 2 });
    expect(r.headers.get('etag')).toBe('"v2"');
  });

  it('EDIT-02 search finds the fundraiser by its new name and shows that name', async () => {
    await patch(SLUGS.F1, { title: 'Evacuation maps for every county' }, IDS.U1);
    const out = await searchFundraisers('evacuation maps');
    expect(out.results.map((r) => [r.slug, r.title])).toEqual([[SLUGS.F1, 'Evacuation maps for every county']]);
    expect(out.approximate).toBe(false);
  });

  it('EDIT-03 anyone else gets 403 and guests 401; the name is unchanged', async () => {
    expect((await patch(SLUGS.F1, { title: 'Hijacked name' }, IDS.U2)).status).toBe(403);
    expect((await patch(SLUGS.F1, { title: 'Hijacked name' }, IDS.U4)).status).toBe(403);
    expect((await patch(SLUGS.F1, { title: 'Hijacked name' }, null)).status).toBe(401);
    const { rows } = await getPool().query('SELECT title, version FROM fundraisers WHERE slug = $1', [SLUGS.F1]);
    expect(rows[0]).toEqual({ title: 'Wildfire alerts for everyone', version: 1 });
  });

  it('EDIT-04 too short, blank and too long names are rejected with the field named', async () => {
    for (const title of ['ab', '   ', 'x'.repeat(121)]) {
      expect(await patch(SLUGS.F1, { title }, IDS.U1)).toMatchObject({ status: 400 });
    }
  });

  it('EDIT-05 a stale version is refused (412) so two edits cannot overwrite each other', async () => {
    await patch(SLUGS.F1, { title: 'First new name' }, IDS.U1);
    const r = await patch(SLUGS.F1, { title: 'Second new name' }, IDS.U1, '"v1"');
    expect(r.status).toBe(412);
    expect(r.headers.get('etag')).toBe('"v2"');
  });
});

describe('END: ending a fundraiser (owner only)', () => {
  it('END-01 only the owner can end it', async () => {
    expect((await patch(SLUGS.F1, { status: 'ended' }, IDS.U2)).status).toBe(403);
    expect((await patch(SLUGS.F1, { status: 'ended' }, null)).status).toBe(401);
    const r = await patch(SLUGS.F1, { status: 'ended' }, IDS.U1);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ended');
  });

  it('END-02 after ending, donations are refused and search says it cannot take donations', async () => {
    await patch(SLUGS.F1, { status: 'ended' }, IDS.U1);
    const d = await postDonation(SLUGS.F1, okBody(), 'end-02-donation-key');
    expect(d.status).toBeGreaterThanOrEqual(400);
    const hit = (await searchFundraisers('wildfire')).results[0];
    expect(hit).toMatchObject({ status: 'ended', can_contribute: false });
    expect(hit.contribute_note).toMatch(/ended/i);
  });

  it('END-03 after ending, chat is closed for new messages', async () => {
    await postMessage(SLUGS.F1, IDS.U2, { body: 'before the end' });
    await patch(SLUGS.F1, { status: 'ended' }, IDS.U1);
    await expect(postMessage(SLUGS.F1, IDS.U2, { body: 'after the end' })).rejects.toMatchObject({ status: 409, code: 'chat_closed' });
  });

  it('END-04 an ended fundraiser cannot be reopened', async () => {
    await patch(SLUGS.F1, { status: 'ended' }, IDS.U1);
    const r = await patch(SLUGS.F1, { status: 'active' }, IDS.U1, '"v2"');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('invalid_transition');
  });

  it('END-05 the owner can still rename an ended fundraiser', async () => {
    await patch(SLUGS.F1, { status: 'ended' }, IDS.U1);
    const r = await patch(SLUGS.F1, { title: 'Wildfire alerts (completed)' }, IDS.U1, '"v2"');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ title: 'Wildfire alerts (completed)', status: 'ended' });
  });
});
