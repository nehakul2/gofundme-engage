'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { authHeaders } from './viewer';

// Sends one page view per route change. Failures are ignored: analytics never blocks the page.
export default function Beacon() {
  const path = usePathname();
  useEffect(() => {
    fetch('/api/v1/events', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ type: 'page_view', path, ...(window.location.search.includes('from=notification') ? { source: 'notification' } : {}) }),
    }).catch(() => undefined);
  }, [path]);
  return null;
}
