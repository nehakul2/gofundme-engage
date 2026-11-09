'use client';
import { useEffect, useState } from 'react';
import { formatUsd } from '@/lib/money';

interface Line { key: number; text: string; at: string }
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// "Live now": the last few settled donations, newest first, as they happen.
// Names of anonymous donors never reach this component (the stream says "Someone").
export default function PulseTicker({ slug, onPulse }: { slug: string; onPulse?: () => void }) {
  const [lines, setLines] = useState<Line[]>([]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let n = 0;
    const es = new EventSource(`/api/v1/fundraisers/${slug}/pulse`);
    es.addEventListener('pulse', (e) => {
      const m = JSON.parse((e as MessageEvent).data);
      const text = m.kind === 'summary'
        ? `${m.count} new donations, ${formatUsd(m.amount_cents)} in total`
        : `${m.name ?? 'Someone'} just donated ${formatUsd(m.amount_cents)}`;
      onPulse?.(); // counters are already updated when the pulse is written, so refresh the numbers now
      const key = ++n;
      setLines((l) => [{ key, text, at: m.at ?? new Date().toISOString() }, ...l].slice(0, 5));
    });
    return () => es.close(); // EventSource reconnects by itself if the connection drops
  }, [slug]); // onPulse is intentionally not a dependency: reconnecting on every render would drop messages

  return (
    <section className="card livecard" aria-label="Live now">
      <p className="live-h"><span className="dot" aria-hidden="true" />Live now</p>
      <ul className="pulse-list" aria-live="polite" aria-atomic="false">
        {lines.length === 0 && <li className="muted" style={{ animation: 'none' }}>Waiting for the next donation…</li>}
        {lines.map((l) => <li key={l.key}><span>{l.text}</span><time dateTime={l.at}>{clock(l.at)}</time></li>)}
      </ul>
    </section>
  );
}
