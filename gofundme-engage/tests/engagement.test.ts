import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis } from '@/lib/redis';
import { IDS, SLUGS } from '@/fixtures';
import { recordShare, setFollow } from '@/lib/engagement';
import { getStats } from '@/lib/stats';
import { getCommunityPage, getFundraiserPage, getProfilePage } from '@/lib/read';
import { resetAll } from './helpers';

beforeEach(resetAll);
afterAll(async () => { await closePool(); await closeRedis(); });

const target = { target_type: 'fundraiser', target_id: IDS.F1 };

describe('follow and share', () => {
  it('follow is idempotent and counted once; unfollow reverses it', async () => {
    expect(await setFollow(IDS.U2, target, true)).toEqual({ following: true, changed: true });
    expect(await setFollow(IDS.U2, target, true)).toEqual({ following: true, changed: false });
    expect((await getStats(SLUGS.F1)).follower_count).toBe(1);
    expect(await setFollow(IDS.U2, target, false)).toEqual({ following: false, changed: true });
    expect(await setFollow(IDS.U2, target, false)).toMatchObject({ changed: false });
    expect((await getStats(SLUGS.F1)).follower_count).toBe(0);
  });

  it('rejects self-follow and unknown targets', async () => {
    await expect(setFollow(IDS.U1, { target_type: 'user', target_id: IDS.U1 }, true)).rejects.toMatchObject({ status: 422 });
    await expect(setFollow(IDS.U1, { target_type: 'user', target_id: IDS.F1.replace(/1$/, '9') }, true)).rejects.toMatchObject({ status: 404 });
  });

  it('counts one share per person, channel and day', async () => {
    const actor = { userId: null, anonId: 'anon-1' };
    expect(await recordShare(SLUGS.F1, { channel: 'copy_link' }, actor)).toEqual({ counted: true });
    expect(await recordShare(SLUGS.F1, { channel: 'copy_link' }, actor)).toEqual({ counted: false });
    expect(await recordShare(SLUGS.F1, { channel: 'x' }, actor)).toEqual({ counted: true });
    expect((await getStats(SLUGS.F1)).share_count).toBe(2);
    expect((await getPool().query('SELECT count(*)::int n FROM shares')).rows[0].n).toBe(2);
  });
});

describe('page read models', () => {
  it('fundraiser, profile and community link to each other', async () => {
    const f = await getFundraiserPage(SLUGS.F2);
    expect(f.owner_handle).toBe('owner');
    expect(f.communities.map((c: { slug: string }) => c.slug)).toEqual([SLUGS.C1]);
    expect(f.donations).toHaveLength(1);
    const p = await getProfilePage('owner');
    expect(p.fundraisers.map((x: { slug: string }) => x.slug).sort()).toEqual([SLUGS.F1, SLUGS.F2, SLUGS.F3].sort()); // removed one hidden
    const c = await getCommunityPage(SLUGS.C1);
    expect(c.fundraisers).toHaveLength(3);
    expect(c.posts).toHaveLength(5);
    expect((await getCommunityPage(SLUGS.C2)).posts).toHaveLength(0);
    await expect(getFundraiserPage(SLUGS.F4)).rejects.toMatchObject({ status: 410 });
  });
});
