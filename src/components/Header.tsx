'use client';
import Link from 'next/link';
import { IDS } from '@/fixtures';
import Bell from './Bell';
import { setViewer, useViewer } from './viewer';

const PEOPLE: [string, string][] = [
  [IDS.U1, 'Olivia Owner'], [IDS.U2, 'Dan Donor'], [IDS.U3, 'Dee Donor'], [IDS.U4, 'Max Moderator'], [IDS.U5, 'Nia Newcomer'],
];

export default function Header() {
  const viewer = useViewer();
  return (
    <header className="topbar">
      <Link href="/" className="brand">Engage</Link>
      <nav className="nav" aria-label="Main">
        <Link href="/">Fundraisers</Link>
        <Link href="/#communities">Communities</Link>
      </nav>
      <form action="/search" role="search" className="topsearch">
        <label htmlFor="topq" className="sr-only">Search fundraisers</label>
        <input id="topq" name="q" type="search" minLength={2} maxLength={100} placeholder="Search fundraisers" />
        <button className="btn secondary" type="submit" style={{ minHeight: 44 }}>Search</button>
      </form>
      <Bell />
      <label className="viewer">
        <span>Viewing as</span>
        <select value={viewer ?? ''} onChange={(e) => setViewer(e.target.value || null)} aria-label="Viewing as">
          <option value="">Guest</option>
          {PEOPLE.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
    </header>
  );
}
