'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { authHeaders, useViewer } from './viewer';

// The bell shows how many notifications the viewer has not read. Guests have no inbox, so no badge.
export default function Bell() {
  const viewer = useViewer();
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    if (!viewer) { setCount(0); return; }
    try {
      const r = await fetch('/api/v1/me/notifications/unread-count', { headers: authHeaders(), cache: 'no-store' });
      if (r.ok) setCount((await r.json()).unread_count ?? 0);
    } catch { /* keep the last number */ }
  }, [viewer]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    window.addEventListener('notifications:changed', load);
    return () => { clearInterval(t); window.removeEventListener('notifications:changed', load); };
  }, [load]);

  return (
    <Link href="/notifications" className="bell" aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}>
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {count > 0 && <span className="badge" aria-hidden="true">{count > 99 ? '99+' : count}</span>}
    </Link>
  );
}
