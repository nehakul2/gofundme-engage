'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatUsd } from '@/lib/money';
import { authHeaders, useViewer } from './viewer';

interface Item { id: string; type: 'milestone' | 'update'; slug: string | null; excerpt: string | null; target_type: string; target_id: string; threshold_pct: number | null; title: string | null; raised_cents: number | null; donor_count: number | null; created_at: string; read: boolean }

// Shows the inbox as it was when opened (unread ones highlighted), then marks everything read.
export default function NotificationList() {
  const viewer = useViewer();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!viewer) { setItems(null); return; }
    let live = true;
    (async () => {
      try {
        const r = await fetch('/api/v1/me/notifications', { headers: authHeaders(), cache: 'no-store' });
        if (!r.ok) throw new Error();
        const d = await r.json();
        if (!live) return;
        setItems(d.items);
        if (d.items.some((i: Item) => !i.read)) {
          await fetch('/api/v1/me/notifications/read', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ all: true }) });
          window.dispatchEvent(new Event('notifications:changed'));
        }
      } catch { if (live) setError('Could not load your notifications.'); }
    })();
    return () => { live = false; };
  }, [viewer]);

  if (!viewer) return <p className="muted">Choose who you are under “Viewing as” to see your notifications.</p>;
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!items) return <p className="muted">Loading…</p>;
  if (items.length === 0) return <p className="empty">Nothing yet. You will hear about milestones and updates for fundraisers you own, follow or have given to.</p>;
  return (
    <ul className="notes">
      {items.map((i) => (
        <li key={i.id} className={`card note-item${i.read ? '' : ' unread'}`}>
          <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto', color: 'var(--amber-ink)' }}><circle cx="12" cy="8" r="6" /><path d="M15.5 13.5 17 22l-5-3-5 3 1.5-8.5" /></svg>
          <div>
            {i.type === 'update' ? (
              <>
                <div className="eyebrow">UPDATE{i.read ? '' : ' · NEW'}</div>
                <p style={{ margin: '4px 0 0' }}>
                  <Link href={`/f/${i.slug ?? i.target_id}?from=notification`}>{i.title ?? 'A fundraiser'}</Link> posted an update{i.excerpt ? <>: “{i.excerpt}”</> : '.'}
                </p>
              </>
            ) : (
              <>
                <div className="eyebrow">MILESTONE · {i.threshold_pct}%{i.read ? '' : ' · NEW'}</div>
                <p style={{ margin: '4px 0 0' }}>
                  <Link href={`/f/${i.slug ?? i.target_id}?from=notification`}>{i.title ?? 'A fundraiser'}</Link> reached {i.threshold_pct}% of its goal
                  {i.raised_cents != null && i.donor_count != null && <>: {formatUsd(i.raised_cents)} from {i.donor_count} {i.donor_count === 1 ? 'supporter' : 'supporters'}</>}.
                </p>
              </>
            )}
            <small className="muted">{new Date(i.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small>
          </div>
        </li>
      ))}
    </ul>
  );
}
