'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUsd } from '@/lib/money';
import DonateForm from './DonateForm';
import PulseTicker from './PulseTicker';
import FollowButton from './FollowButton';
import ShareButton from './ShareButton';
import ChatRoom from './ChatRoom';
import type React from 'react';

interface Stats { raised_cents: number; goal_cents: number; donor_count: number; share_count: number; follower_count: number; percent_of_goal: number; status: string }
interface Donation { id: string; amount_cents: number; display_name: string | null; message: string | null; created_at: string }

// How old the last visit must be before "since you last visited" appears.
const MIN_MINUTES = Number(process.env.NEXT_PUBLIC_BANNER_MIN_MINUTES ?? 60);

type TimelineItem =
  | { kind: 'update'; id: string; body: string; created_at: string; author_name: string; author_handle: string }
  | { kind: 'milestone'; id: string; pct: number; raised_cents: number; donor_count: number; created_at: string };
const PAGE = 10;
const TICKS = [25, 50, 75];

export default function LiveFundraiser(props: {
  id: string; slug: string; ownerId: string; initial: Stats; initialDonations: Donation[];
  intro: React.ReactNode; story: React.ReactNode; timeline: TimelineItem[];
}) {
  const [stats, setStats] = useState(props.initial);
  const [donations, setDonations] = useState(props.initialDonations);
  const [timeline, setTimeline] = useState(props.timeline);
  const [showAll, setShowAll] = useState(false);
  const [banner, setBanner] = useState('');
  const snapKey = `snap:${props.id}`;
  const first = useRef(props.initial);

  // Whatever this browser has seen live counts as seen: the snapshot follows the live numbers
  const remember = useCallback((st: Stats) => {
    try { localStorage.setItem(snapKey, JSON.stringify({ t: Date.now(), raised: st.raised_cents, donors: st.donor_count })); } catch { /* storage blocked */ }
  }, [snapKey]);

  const refresh = useCallback(async () => {
    try {
      // Independent requests: a slow or failed one must not hold back the others
      const get = (path: string, init?: RequestInit) => fetch(`/api/v1/fundraisers/${props.slug}/${path}`, init).then((r) => r.json());
      const [s, d, t] = await Promise.allSettled([
        get('stats'),
        get(`donations?limit=${showAll ? 50 : PAGE}`),
        get('updates', { cache: 'no-store' }),
      ]);
      if (s.status === 'fulfilled' && s.value.raised_cents !== undefined) { setStats(s.value); remember(s.value); }
      if (d.status === 'fulfilled' && d.value.items) setDonations(d.value.items);
      // Milestones and organizer updates arrive without a reload
      if (t.status === 'fulfilled' && Array.isArray(t.value.items)) setTimeline(t.value.items);
    } catch { /* keep showing the last good numbers */ }
  }, [props.slug, remember, showAll]);

  useEffect(() => { const t = setInterval(refresh, 4000); return () => clearInterval(t); }, [refresh]);
  // The owner's controls announce a change (renamed, ended) so the donate card and chat update at once
  useEffect(() => { const on = () => { refresh(); }; window.addEventListener('fundraiser:changed', on); return () => window.removeEventListener('fundraiser:changed', on); }, [refresh]);

  // "Since you last visited": compare against what this browser saw last time.
  useEffect(() => {
    try {
      const now = Date.now();
      const raw = localStorage.getItem(snapKey);
      const snap = raw ? JSON.parse(raw) : null;
      const cur = first.current;
      const save = () => localStorage.setItem(snapKey, JSON.stringify({ t: now, raised: cur.raised_cents, donors: cur.donor_count }));
      if (!snap) return save();
      if (now - snap.t < MIN_MINUTES * 60_000) return;
      const gained = cur.raised_cents - snap.raised;
      const people = cur.donor_count - snap.donors;
      if (gained > 0 && people > 0) setBanner(`${people} more ${people === 1 ? 'supporter' : 'supporters'} gave ${formatUsd(gained)}.`);
      save();
    } catch { /* storage blocked: skip the banner */ }
  }, [snapKey]);

  const pct = Math.min(stats.percent_of_goal, 100);
  const open = stats.status === 'active';
  const next = [25, 50, 75, 100].find((t) => t > stats.percent_of_goal);
  return (
    <>
      {banner && (
        <div className="banner" role="status">
          <span><strong>Since you last visited:</strong> {banner}</span>
          <button className="btn" onClick={() => setBanner('')}>Dismiss</button>
        </div>
      )}
      <div className="layout">
        <div className="slot slot-intro">{props.intro}</div>

        <aside>
          <section className="card sidecard" id="donate" aria-label="Progress and donating">
            <p className="raised"><strong>{formatUsd(stats.raised_cents)}</strong> raised of {formatUsd(stats.goal_cents)} goal</p>
            <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Percent of goal">
              <div style={{ width: `${pct}%` }} />
              {TICKS.map((t) => <i key={t} aria-hidden="true" style={{ left: `${t}%` }} />)}
            </div>
            <div className="barlabels"><span>{stats.percent_of_goal}% funded</span><span>{next ? `Next: ${next}%` : 'Goal reached'}</span></div>
            <p className="counts"><span><strong>{stats.donor_count}</strong> {stats.donor_count === 1 ? 'supporter' : 'supporters'}</span><span><strong>{stats.share_count}</strong> {stats.share_count === 1 ? 'share' : 'shares'}</span><span><strong>{stats.follower_count}</strong> {stats.follower_count === 1 ? 'follower' : 'followers'}</span></p>
            {open
              ? <DonateForm slug={props.slug} onDone={refresh} bare />
              : <p className="muted">This fundraiser is {stats.status} and is not taking donations.</p>}
            <div className="actions"><ShareButton slug={props.slug} onChange={refresh} /><FollowButton type="fundraiser" id={props.id} onChange={refresh} /></div>
            {open && <p className="fine">Donations count once the payment is confirmed. Donating anonymously hides your name from other visitors.</p>}
          </section>
          <PulseTicker slug={props.slug} onPulse={refresh} />
        </aside>

        <section className="card slot slot-story" aria-label="Story">
          <h2>The story</h2>
          {props.story}
        </section>

        {timeline.length > 0 && (
          <section className="card slot slot-updates" aria-label="Updates">
            <h2>Updates</h2>
            <div className="stack">
              {timeline.map((m) => m.kind === 'milestone' ? (
                <div key={m.id} className="milestone-card">
                  <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="6" /><path d="M15.5 13.5 17 22l-5-3-5 3 1.5-8.5" /></svg>
                  <div>
                    <div className="eyebrow">MILESTONE · {m.pct}%</div>
                    <p>Reached {m.pct}% of the {formatUsd(stats.goal_cents)} goal, {m.donor_count.toLocaleString('en-US')} {m.donor_count === 1 ? 'supporter' : 'supporters'} so far.</p>
                  </div>
                </div>
              ) : (
                <div key={m.id} className="update-card">
                  <div className="eyebrow">UPDATE FROM THE ORGANIZER</div>
                  <p className="update-body">{m.body}</p>
                  <small className="muted">{m.author_name} · {new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</small>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="card slot slot-supporters" aria-label="Recent supporters">
          <h2>Recent supporters</h2>
          {donations.length === 0 ? <p className="muted">Be the first to give.</p> : (
            <ul className="supporters">
              {donations.map((d) => (
                <li key={d.id} className="supporter">
                  <span className="avatar sm" aria-hidden="true">{(d.display_name ?? 'A').slice(0, 1).toUpperCase()}</span>
                  <div className="supporter-main">
                    <strong>{d.display_name ?? 'Anonymous'}</strong> <span>{formatUsd(d.amount_cents)}</span>
                    {d.message && <p>“{d.message}”</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {(donations.length >= PAGE || showAll) && (
            <button className="btn secondary" style={{ width: 'auto', marginTop: 12 }} onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : 'Show more supporters'}</button>
          )}
        </section>

        {open && <a className="btn primary donatebar" href="#donate">Donate now</a>}
        <div className="card slot slot-chat"><ChatRoom slug={props.slug} ownerId={props.ownerId} open={open} /></div>
      </div>
    </>
  );
}
