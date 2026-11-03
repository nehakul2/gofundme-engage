import Link from 'next/link';
import ChatDock from '@/components/ChatDock';
import FundraiserCard from '@/components/FundraiserCard';
import { getPool } from '@/lib/db';
import { percentOfGoal } from '@/lib/money';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const pool = getPool();
  const [fr, cm] = await Promise.all([
    pool.query(
      `SELECT f.id, f.slug, f.title, f.status, f.goal_cents, COALESCE(s.raised_cents,0) AS raised_cents, COALESCE(s.donor_count,0) AS donor_count
         FROM fundraisers f LEFT JOIN fundraiser_stats s ON s.fundraiser_id = f.id
        WHERE f.status IN ('active','ended') ORDER BY f.created_at DESC`,
    ),
    pool.query('SELECT slug, name, description FROM communities ORDER BY name'),
  ]);
  return (
    <>
      <h1>Fundraisers worth coming back to</h1>
      <p className="muted">Find a fundraiser, see where it stands, and join the people behind it.</p>
      <h2 id="fundraisers">Fundraisers</h2>
      {fr.rows.length === 0 ? (
        <p className="empty">Nothing here yet. Run <code>npm run seed</code>.</p>
      ) : (
        <ul className="grid">
          {fr.rows.map((f) => <FundraiserCard key={f.id} f={{ ...f, percent_of_goal: percentOfGoal(f.raised_cents, f.goal_cents) }} />)}
        </ul>
      )}
      <h2 id="communities">Communities</h2>
      <ul className="grid">
        {cm.rows.map((c) => (
          <li key={c.slug}><Link href={`/c/${c.slug}`} className="card fcard"><h3>{c.name}</h3><p className="muted" style={{ margin: 0 }}>{c.description}</p></Link></li>
        ))}
      </ul>
      <ChatDock />
    </>
  );
}
