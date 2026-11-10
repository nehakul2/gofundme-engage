import Link from 'next/link';
import { formatUsd } from '@/lib/money';

export interface CardData { slug: string; title: string; status: string; goal_cents: number; raised_cents: number; donor_count: number; percent_of_goal: number; cover_url?: string | null }

// A soft green gradient stands in when the organizer has not added a photo; the hue comes from the link name so each card keeps its own colour.
function hue(slug: string) { let h = 0; for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) % 60; return 120 + h; }

export default function FundraiserCard({ f }: { f: CardData }) {
  return (
    <li>
      <Link href={`/f/${f.slug}`} className="card fcard">
        {f.cover_url
          ? <img className="fcard-img" src={f.cover_url} alt="" loading="lazy" />
          : <div className="fcard-img ph" aria-hidden="true" style={{ background: `linear-gradient(135deg, hsl(${hue(f.slug)} 45% 88%), hsl(${hue(f.slug) + 25} 50% 72%))` }}>{f.title.slice(0, 1).toUpperCase()}</div>}
        <div className="fcard-body">
          <h3>{f.title}</h3>
          <span className={f.status === 'active' ? 'tag' : 'tag no'}>{f.status === 'active' ? 'Active' : f.status === 'ended' ? 'Ended' : f.status}</span>
          <div className="bar thin" aria-hidden><div style={{ width: `${Math.min(f.percent_of_goal, 100)}%` }} /></div>
          <p style={{ margin: 0 }}><strong>{formatUsd(f.raised_cents)}</strong> raised of {formatUsd(f.goal_cents)} · {f.donor_count} {f.donor_count === 1 ? 'supporter' : 'supporters'}</p>
        </div>
      </Link>
    </li>
  );
}
