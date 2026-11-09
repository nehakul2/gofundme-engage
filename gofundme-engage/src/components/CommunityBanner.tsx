'use client';
import { useEffect, useState } from 'react';
import { formatUsd } from '@/lib/money';

// How old the last visit must be before the banner appears (same setting as the fundraiser page).
const MIN_MINUTES = Number(process.env.NEXT_PUBLIC_BANNER_MIN_MINUTES ?? 60);

interface Snap { t: number; raised: number; posts: number; members: number; fundraisers: number }

// "Since you last visited" for a community: money raised across its fundraisers, new updates and new
// members since this browser last looked. The first visit only records a snapshot; nothing is shown.
export default function CommunityBanner(props: { id: string; raisedCents: number; posts: number; members: number; fundraisers: number }) {
  const [text, setText] = useState('');
  const key = `snap:c:${props.id}`;

  useEffect(() => {
    try {
      const now = Date.now();
      const cur: Snap = { t: now, raised: props.raisedCents, posts: props.posts, members: props.members, fundraisers: props.fundraisers };
      const raw = localStorage.getItem(key);
      const snap: Snap | null = raw ? JSON.parse(raw) : null;
      if (!snap) { localStorage.setItem(key, JSON.stringify(cur)); return; }
      if (now - snap.t < MIN_MINUTES * 60_000) return;
      const parts: string[] = [];
      const raised = cur.raised - snap.raised;
      const posts = cur.posts - snap.posts;
      const members = cur.members - snap.members;
      const frs = cur.fundraisers - snap.fundraisers;
      if (raised > 0) parts.push(`${formatUsd(raised)} raised`);
      if (posts > 0) parts.push(`${posts} new ${posts === 1 ? 'update' : 'updates'}`);
      if (frs > 0) parts.push(`${frs} new ${frs === 1 ? 'fundraiser' : 'fundraisers'}`);
      if (members > 0) parts.push(`${members} new ${members === 1 ? 'member' : 'members'}`);
      if (parts.length) setText(parts.join(', '));
      localStorage.setItem(key, JSON.stringify(cur));
    } catch { /* storage blocked: skip the banner */ }
  }, [key, props.raisedCents, props.posts, props.members, props.fundraisers]);

  if (!text) return null;
  return (
    <div className="banner" role="status">
      <span><strong>Since you last visited:</strong> {text}.</span>
      <button className="btn" onClick={() => setText('')}>Dismiss</button>
    </div>
  );
}
