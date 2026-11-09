import type { Metadata } from 'next';
import Link from 'next/link';
import CommunityActions from '@/components/CommunityActions';
import CommunityBanner from '@/components/CommunityBanner';
import CopyLinkButton from '@/components/CopyLinkButton';
import FollowButton from '@/components/FollowButton';
import FundraiserCard from '@/components/FundraiserCard';
import { getCommunityPage } from '@/lib/read';
import { load } from '@/lib/page';

export const dynamic = 'force-dynamic';
type P = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { slug } = await params;
  const c = await load(() => getCommunityPage(slug));
  return { title: c === 'gone' ? 'Community' : `${c.name} | Engage` };
}

const date = (d: Date) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export default async function CommunityPage({ params }: P) {
  const { slug } = await params;
  const c = await load(() => getCommunityPage(slug));
  if (c === 'gone') return null;
  return (
    <article>
      <CommunityBanner id={c.id} raisedCents={c.raised_cents} posts={c.post_count} members={c.member_count} fundraisers={c.fundraisers.length} />
      <section className="card hero" aria-label="Community">
        <div className="grow">
          <h1>{c.name}</h1>
          {c.description && <p className="bio">{c.description}</p>}
          <div className="stats" style={{ border: 0, paddingTop: 12 }}>
            <span><strong>{c.member_count}</strong> {c.member_count === 1 ? 'member' : 'members'}</span>
            <span><strong>{c.fundraisers.length}</strong> {c.fundraisers.length === 1 ? 'fundraiser' : 'fundraisers'}</span>
            <span><strong>{c.follower_count}</strong> {c.follower_count === 1 ? 'follower' : 'followers'}</span>
          </div>
        </div>
        <div className="acts"><FollowButton type="community" id={c.id} /><CopyLinkButton /></div>
      </section>

      <CommunityActions slug={c.slug} />

      <div className="two-col">
        <section aria-label="Updates">
          <h2>Updates</h2>
          {c.posts.length === 0 ? (
            <p className="empty">Nothing posted yet.</p>
          ) : (
            <div className="stack">
              {c.posts.map((p) => (
                <div key={p.id} className={p.kind === 'milestone' ? 'post milestone' : p.kind === 'update' ? 'post update' : 'post'}>
                  {p.kind === 'milestone' && (
                    <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="6" /><path d="M15.5 13.5 17 22l-5-3-5 3 1.5-8.5" /></svg>
                  )}
                  <div>
                    {p.kind === 'milestone' && <div className="eyebrow">MILESTONE · {p.milestone_pct}%</div>}
                    {p.kind === 'update' && <div className="eyebrow">UPDATE{p.fundraiser_slug ? <> · <Link href={`/f/${p.fundraiser_slug}`}>{p.fundraiser_title}</Link></> : null}</div>}
                    <p style={{ margin: p.kind === 'milestone' ? '4px 0 0' : 0 }}>{p.body}</p>
                    <small><Link href={`/u/${p.handle}`}>{p.display_name}</Link> · {date(p.created_at)}</small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside aria-label="Fundraisers and members">
          <h2>Fundraisers</h2>
          {c.fundraisers.length === 0 ? (
            <p className="empty">No fundraisers in this community yet.</p>
          ) : (
            <ul className="list">{c.fundraisers.map((f) => <FundraiserCard key={f.id} f={f} />)}</ul>
          )}
          <h2 style={{ marginTop: 32 }}>Members</h2>
          <ul className="pills">
            {c.members.map((m) => <li key={m.handle}><Link className="tag" href={`/u/${m.handle}`}>{m.display_name}{m.role !== 'member' ? ` · ${m.role}` : ''}</Link></li>)}
          </ul>
        </aside>
      </div>
    </article>
  );
}
