'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authHeaders, useViewer } from './viewer';

interface Msg { id: string; user: { id: string; handle: string; display_name: string }; is_organizer: boolean; body: string; created_at: string }

const MAX = 500;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// Merge by id, keep time order (ids are UUIDv7, so id order is time order).
function merge(a: Msg[], b: Msg[]): Msg[] {
  const byId = new Map<string, Msg>();
  for (const m of [...a, ...b]) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : 1));
}

interface Props { slug?: string; ownerId?: string; open?: boolean; basePath?: string; title?: string; empty?: string; join?: string }

// One component for every room: a fundraiser's (pass slug) or the homepage lobby (pass basePath).
export default function ChatRoom({ slug, ownerId = '', open = true, basePath, title = 'Supporter chat', empty = 'No messages yet. Say hello.', join = 'Choose who you are under “Viewing as” to join the chat. Guests can read along.' }: Props) {
  const viewer = useViewer();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [live, setLive] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const stick = useRef(true);
  const latest = useRef('');
  const base = basePath ?? `/api/v1/fundraisers/${slug}/chat`;

  useEffect(() => { latest.current = msgs.length ? msgs[msgs.length - 1].id : ''; }, [msgs]);

  const catchUp = useCallback(async () => {
    try {
      const q = latest.current ? `?after=${latest.current}&limit=100` : '?limit=50';
      const r = await fetch(`${base}${q}`, { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      setMsgs((cur) => merge(cur, d.messages));
      if (!latest.current) setHasMore(d.has_more);
    } catch { /* the stream will bring it */ }
  }, [base]);

  // History first, then the live stream. Every (re)connect catches up on what was missed.
  useEffect(() => {
    let closed = false;
    (async () => { await catchUp(); if (!closed) setLoaded(true); })();
    const es = new EventSource(`${base}/stream`);
    es.addEventListener('ready', () => { setLive(true); catchUp(); });
    es.addEventListener('message', (e) => { setMsgs((cur) => merge(cur, [JSON.parse((e as MessageEvent).data)])); });
    es.addEventListener('removed', (e) => {
      const ids: string[] = JSON.parse((e as MessageEvent).data).ids;
      setMsgs((cur) => cur.filter((m) => !ids.includes(m.id)));
    });
    es.onerror = () => setLive(false);
    return () => { closed = true; es.close(); };
  }, [base, catchUp]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  async function older() {
    if (!msgs.length) return;
    const r = await fetch(`${base}?before=${msgs[0].id}&limit=50`, { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    stick.current = false;
    setMsgs((cur) => merge(d.messages, cur));
    setHasMore(d.has_more);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true); setError('');
    try {
      const r = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ body, client_id: crypto.randomUUID() }),
      });
      const d = await r.json();
      if (r.ok) { stick.current = true; setMsgs((cur) => merge(cur, [d])); setText(''); }
      else if (r.status === 429) setError(`You are sending too fast. Try again in ${r.headers.get('retry-after') ?? 'a few'} seconds.`);
      else if (r.status === 401) setError('Choose who you are under "Viewing as" to chat.');
      else setError(d.error?.message ?? 'Your message was not sent.');
    } catch { setError('Could not reach the server. Your message was not sent.'); }
    finally { setSending(false); }
  }

  async function remove(id: string) {
    setMsgs((cur) => cur.filter((m) => m.id !== id));
    const r = await fetch(`${base}/${id}`, { method: 'DELETE', headers: authHeaders() });
    if (!r.ok) { setError('That message could not be removed.'); catchUp(); }
  }

  return (
    <section className="chat" aria-labelledby={`chat-h-${base}`}>
      <h2 id={`chat-h-${base}`}>{title} {live && <span className="tag yes" title="Messages appear as they are sent">Live</span>}</h2>
      <ul
        ref={listRef}
        className="chat-log"
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
      >
        {hasMore && <li><button className="linklike" onClick={older}>Show earlier messages</button></li>}
        {loaded && msgs.length === 0 && <li className="muted">{empty}</li>}
        {!loaded && <li className="muted">Loading messages…</li>}
        {msgs.map((m) => (
          <li key={m.id} className={`chat-msg${m.user.id === viewer ? ' mine' : ''}`}>
            <div className="chat-meta">
              <strong>{m.user.display_name}</strong>
              {m.is_organizer && <span className="tag">Organizer</span>}
              <time dateTime={m.created_at}>{time(m.created_at)}</time>
              {(m.user.id === viewer || (!!ownerId && viewer === ownerId)) && (
                <button className="linklike" onClick={() => remove(m.id)} aria-label={`Remove message from ${m.user.display_name}`}>Remove</button>
              )}
            </div>
            <p>{m.body}</p>
          </li>
        ))}
      </ul>
      {!open ? (
        <p className="muted">Chat is closed because this fundraiser is no longer active. You can still read the conversation.</p>
      ) : !viewer ? (
        <p className="muted">{join}</p>
      ) : (
        <form onSubmit={send} className="chat-form">
          <label htmlFor="chat-input" className="sr-only">Write a message</label>
          <textarea
            id="chat-input" rows={2} maxLength={MAX} value={text} placeholder="Write a message"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
          />
          <div className="chat-actions">
            <span className="muted" aria-live="off">{text.length}/{MAX}</span>
            <button className="btn primary" type="submit" disabled={sending || !text.trim()} style={{ width: 'auto' }}>Send</button>
          </div>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
