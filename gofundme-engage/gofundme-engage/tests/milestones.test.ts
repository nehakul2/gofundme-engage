import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis, getRedis, keys } from '@/lib/redis';
import { IDS, SLUGS, GOAL_CENTS } from '@/fixtures';
import { detectMilestones } from '@/lib/milestones';
import { postDonation, okBody, resetAll, settle, webhook } from './helpers';

beforeEach(resetAll);
afterAll(async () => { await closePool(); await closeRedis(); });

let n = 0;
async function donate(fr: string, cents: number) {
  const id = (await postDonation(fr, okBody(cents), `ms-key-${++n}-${Date.now()}-aaaa`)).body.id;
  await webhook('payment.succeeded', id);
  return id as string;
}
const q = async (sql: string, p: unknown[] = []) => (await getPool().query(sql, p)).rows;
const reached = async (fid: string) =>
  (await q('SELECT threshold_pct FROM fundraiser_milestones WHERE fundraiser_id = $1 ORDER BY 1', [fid])).map((r) => r.threshold_pct);
const events = async () => q("SELECT payload FROM outbox_events WHERE event_type = 'milestone.reached' ORDER BY id");

describe('milestones', () => {
  it('MIL-01 crossing 25% records it once and writes a post and a notification', async () => {
    await donate(SLUGS.F1, GOAL_CENTS * 0.25);
    await settle();
    expect(await reached(IDS.F1)).toEqual([25]);
    expect((await q("SELECT 1 FROM posts WHERE kind='milestone' AND fundraiser_id=$1 AND milestone_pct=25", [IDS.F1])).length).toBe(1);
    expect((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND type='milestone'", [IDS.U1])).length).toBe(1);
  });

  it('MIL-02 reaching 100% sets goal_reached_at', async () => {
    await donate(SLUGS.F2, 1_000);
    await settle();
    expect(await reached(IDS.F2)).toEqual([25, 50, 75, 100]);
    const [f] = await q('SELECT goal_reached_at FROM fundraisers WHERE id = $1', [IDS.F2]);
    expect(f.goal_reached_at).not.toBeNull();
  });

  it('MIL-03 a jump over several thresholds sends one event and one collapsed notification', async () => {
    await donate(SLUGS.F1, GOAL_CENTS * 0.6);
    await settle();
    expect(await reached(IDS.F1)).toEqual([25, 50]);
    const evs = await events();
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.thresholds).toEqual([25, 50]);
    const notes = await q("SELECT payload FROM notifications WHERE user_id = $1", [IDS.U1]);
    expect(notes).toHaveLength(1);
    expect(notes[0].payload.threshold_pct).toBe(50);
    expect((await q("SELECT 1 FROM posts WHERE kind='milestone'")).length).toBe(2); // one per threshold in C1
  });

  it('MIL-04 running detection again does not fire anything new', async () => {
    await donate(SLUGS.F1, GOAL_CENTS * 0.3);
    await settle();
    expect(await detectMilestones(IDS.F1)).toEqual([]);
    expect(await Promise.all([detectMilestones(IDS.F1), detectMilestones(IDS.F1)])).toEqual([[], []]);
    expect(await events()).toHaveLength(1);
  });

  it('MIL-05 a refund then re-crossing the threshold does not fire again', async () => {
    const id = await donate(SLUGS.F1, GOAL_CENTS * 0.3);
    await settle();
    await webhook('payment.refunded', id);
    await settle();
    await donate(SLUGS.F1, GOAL_CENTS * 0.3);
    await settle();
    expect(await reached(IDS.F1)).toEqual([25]);
    expect(await events()).toHaveLength(1);
    expect((await q("SELECT 1 FROM posts WHERE kind='milestone'")).length).toBe(1);
  });

  it('MIL-06 posts go only to communities that contain the fundraiser', async () => {
    await donate(SLUGS.F1, GOAL_CENTS * 0.25);
    await settle();
    expect((await q("SELECT 1 FROM posts WHERE kind='milestone' AND community_id=$1", [IDS.C1])).length).toBe(1);
    expect((await q("SELECT 1 FROM posts WHERE kind='milestone' AND community_id=$1", [IDS.C2])).length).toBe(0);
  });

  it('MIL-12 followers are notified too, and unread counters go up', async () => {
    await getPool().query("INSERT INTO follows (follower_id, target_type, target_id) VALUES ($1,'fundraiser',$2)", [IDS.U2, IDS.F1]);
    await donate(SLUGS.F1, GOAL_CENTS * 0.25);
    await settle();
    expect(Number(await getRedis().get(keys.unread(IDS.U2)))).toBe(1);
    expect(Number(await getRedis().get(keys.unread(IDS.U1)))).toBe(1);
    expect((await q("SELECT 1 FROM notifications WHERE user_id = $1", [IDS.U2])).length).toBe(1);
  });

  it('seeded fundraisers do not re-fire their existing milestones', async () => {
    await settle();
    expect(await events()).toHaveLength(0);
  });
});
