import type { Metadata } from 'next';
import Link from 'next/link';
import LiveFundraiser from '@/components/LiveFundraiser';
import ManageFundraiser from '@/components/ManageFundraiser';
import { getFundraiserPage } from '@/lib/read';
import { load } from '@/lib/page';

export const dynamic = 'force-dynamic';
type P = { params: Promise<{ slug: string }> };

const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { slug } = await params;
  const f = await load(() => getFundraiserPage(slug));
  return { title: f === 'gone' ? 'Fundraiser removed' : `${f.title} | Engage` };
}

export default async function FundraiserPage({ params }: P) {
  const { slug } = await params;
  const f = await load(() => getFundraiserPage(slug));
  if (f === 'gone') {
    return <div className="empty"><h1>This fundraiser has been removed</h1><p><Link href="/">Back to home</Link></p></div>;
  }
  const intro = (
    <>
      {f.cover_image_url && <img className="cover" src={f.cover_image_url} alt="" />}
      {f.communities.length > 0 && (
        <ul className="pills" aria-label="Communities">
          {f.communities.map((c) => <li key={c.slug}><Link className="tag" href={`/c/${c.slug}`}>{c.name}</Link></li>)}
        </ul>
      )}
      <h1>{f.title}</h1>
      <Link href={`/u/${f.owner_handle}`} className="owner">
        <span className="avatar" aria-hidden="true">{initials(f.owner_name)}</span>
        <span>{f.owner_name}<small>@{f.owner_handle} · organizer</small></span>
      </Link>
    </>
  );
  return (
    <article>
      <LiveFundraiser
        id={f.id}
        slug={f.slug}
        ownerId={f.owner_id}
        initial={f.stats}
        initialDonations={JSON.parse(JSON.stringify(f.donations))}
        timeline={JSON.parse(JSON.stringify(f.timeline))}
        intro={intro}
        story={<p className="story">{f.story}</p>}
      />
      <ManageFundraiser slug={f.slug} ownerId={f.owner_id} hasCover={!!f.cover_image_url} />
    </article>
  );
}
