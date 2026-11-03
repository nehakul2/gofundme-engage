import type { Metadata } from 'next';
import Link from 'next/link';
import CopyLinkButton from '@/components/CopyLinkButton';
import FollowButton from '@/components/FollowButton';
import FundraiserCard from '@/components/FundraiserCard';
import { formatUsd } from '@/lib/money';
import { getProfilePage } from '@/lib/read';
import { load } from '@/lib/page';

export const dynamic = 'force-dynamic';
type P = { params: Promise<{ handle: string }> };

const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { handle } = await params;
  const p = await load(() => getProfilePage(handle));
  return { title: p === 'gone' ? 'Profile' : `${p.display_name} | Engage` };
}

export default async function ProfilePage({ params }: P) {
  const { handle } = await params;
  const p = await load(() => getProfilePage(handle));
  if (p === 'gone') return null;
  const raised = p.fundraisers.reduce((sum, f) => sum + Number(f.raised_cents), 0);
  return (
    <article>
      <section className="card hero" aria-label="Profile">
        <span className="avatar big" aria-hidden="true">{initials(p.display_name)}</span>
        <div className="grow">
          <h1>{p.display_name}</h1>
          <div className="muted">@{p.handle}</div>
          {p.bio && <p className="bio">{p.bio}</p>}
        </div>
        <div className="acts"><FollowButton type="user" id={p.id} /><CopyLinkButton label="Share profile" /></div>
        <div className="stats">
          <span><strong>{p.fundraisers.length}</strong> {p.fundraisers.length === 1 ? 'fundraiser' : 'fundraisers'}</span>
          <span><strong>{formatUsd(raised)}</strong> raised in total</span>
          <span><strong>{p.communities.length}</strong> {p.communities.length === 1 ? 'community' : 'communities'}</span>
          <span><strong>{p.follower_count}</strong> {p.follower_count === 1 ? 'follower' : 'followers'}</span>
          <span><strong>{p.donations_made}</strong> {p.donations_made === 1 ? 'donation' : 'donations'} made</span>
        </div>
      </section>

      <div className="two-col">
        <section aria-label="Fundraisers">
          <h2>Fundraisers</h2>
          {p.fundraisers.length === 0 ? (
            <p className="empty">No fundraisers yet.</p>
          ) : (
            <ul className="list">{p.fundraisers.map((f) => <FundraiserCard key={f.id} f={f} />)}</ul>
          )}
        </section>
        <aside aria-label="Communities">
          <h2>Communities</h2>
          {p.communities.length === 0 ? (
            <p className="muted">Not part of any community yet.</p>
          ) : (
            <ul className="list">
              {p.communities.map((c) => (
                <li key={c.slug}>
                  <Link href={`/c/${c.slug}`} className="card fcard">
                    <h3>{c.name}</h3>
                    <span className="muted">{c.role === 'member' ? 'Member' : c.role === 'owner' ? 'Owner' : 'Moderator'}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </article>
  );
}
