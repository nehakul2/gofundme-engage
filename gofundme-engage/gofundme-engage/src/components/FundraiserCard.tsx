import Link from 'next/link';
import { formatUsd } from '@/lib/money';

export interface CardData { slug: string; title: string; status: string; goal_cents: number; raised_cents: number; donor_count: number; percent_of_goal: number }

export default function FundraiserCard({ f }: { f: CardData }) {
  return (
    <li>
      <Link href={`/f/${f.slug}`} className="card fcard">
        <h3>{f.title}</h3>
        <span className={f.status === 'active' ? 'tag' : 'tag no'}>{f.status === 'active' ? 'Active' : f.status === 'ended' ? 'Ended' : f.status}</span>
        <div className="bar thin" aria-hidden><div style={{ width: `${Math.min(f.percent_of_goal, 100)}%` }} /></div>
        <p style={{ margin: 0 }}><strong>{formatUsd(f.raised_cents)}</strong> of {formatUsd(f.goal_cents)} · {f.donor_count} {f.donor_count === 1 ? 'supporter' : 'supporters'}</p>
      </Link>
    </li>
  );
}
