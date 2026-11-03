'use client';
import { useState } from 'react';

// "Share" for pages that are not fundraisers (profiles, communities): copy the link.
export default function CopyLinkButton({ label = 'Share' }: { label?: string }) {
  const [msg, setMsg] = useState('');
  async function copy() {
    try {
      if (typeof navigator.share === 'function') await navigator.share({ url: window.location.href });
      else await navigator.clipboard.writeText(window.location.href);
      setMsg(typeof navigator.share === 'function' ? 'Shared' : 'Link copied');
    } catch { setMsg('Copy the link from your address bar'); }
    setTimeout(() => setMsg(''), 2500);
  }
  return (
    <span className="follow">
      <button className="btn secondary" onClick={copy}>{label}</button>
      {msg && <small className="note" role="status">{msg}</small>}
    </span>
  );
}
