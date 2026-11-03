'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { formatUsd } from '@/lib/money';
import { parseGoalCents } from '@/lib/goal';
import { startIntent, titleCase1 } from '@/lib/intent';
import { authHeaders, useViewer } from './viewer';

interface Hit { id: string; slug: string; title: string; owner_name: string; raised_cents: number; goal_cents: number; can_contribute: boolean; contribute_note: string | null }
type Action = 'start' | 'confirm' | 'cancel';
type Turn =
  | { who: 'you'; text: string }
  | { who: 'finder'; text: string; hits?: Hit[]; actions?: Action[]; link?: { href: string; label: string } };

// Draft of a fundraiser being created in the chat. step says what the next typed answer means.
interface Draft { step: 'title' | 'goal' | 'story' | 'confirm'; title: string; goal_cents: number; story: string }

const STORY_MIN = 20;
const STORY_MAX = 1000;
const HELLO = 'Tell me what you care about, like “wildfire” or “school”. I will find fundraisers you can join, or help you start one.';

// Question box over the search API. Matches are shown first; if none fit, it walks the person
// through starting their own fundraiser (title, goal, story, confirm) and creates it.
export default function FundraiserFinder() {
  const viewer = useViewer();
  const [turns, setTurns] = useState<Turn[]>([{ who: 'finder', text: HELLO }]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const lastQuery = useRef('');
  const end = useRef<HTMLDivElement>(null);

  const say = (...t: Turn[]) => {
    setTurns((cur) => [...cur, ...t]);
    setTimeout(() => end.current?.scrollIntoView({ block: 'nearest' }), 0);
  };

  function begin(suggest = '') {
    if (!viewer) {
      say({ who: 'finder', text: 'To start a fundraiser, choose who you are under “Viewing as” at the top of the page, then press Start again.', actions: ['start'] });
      return;
    }
    setDraft({ step: 'title', title: '', goal_cents: 0, story: '' });
    if (suggest) {
      setText(titleCase1(suggest).slice(0, 120));
      say({ who: 'finder', text: `Let’s start one. I put “${titleCase1(suggest)}” in the box as a title. Press Send to keep it, or change it first. Type “cancel” at any time to stop.` });
    } else {
      say({ who: 'finder', text: `Let’s start one. What should it be called? For example: “Help rebuild after the ${lastQuery.current || 'storm'}”. Type “cancel” at any time to stop.` });
    }
  }

  function cancel() {
    setDraft(null);
    say({ who: 'finder', text: 'Okay, nothing was created. Ask me anything else.' });
  }

  async function create(d: Draft) {
    setBusy(true);
    try {
      const r = await fetch('/api/v1/fundraisers', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ title: d.title, story: d.story, goal_cents: d.goal_cents, publish: true }),
      });
      const f = await r.json();
      if (r.ok) {
        setDraft(null);
        say({ who: 'finder', text: `Done. “${f.title}” is live and taking donations.`, link: { href: `/f/${f.slug}`, label: 'Open your fundraiser' } });
      } else if (r.status === 429) {
        setDraft(null);
        say({ who: 'finder', text: f.error?.message ?? 'You have started too many fundraisers for now.' });
      } else if (r.status === 401) {
        setDraft(null);
        say({ who: 'finder', text: 'Choose who you are under “Viewing as”, then try again.' });
      } else {
        // Validation problem: go back to the step that owns the field
        const step = f.error?.field === 'title' ? 'title' : f.error?.field === 'goal_cents' ? 'goal' : 'story';
        setDraft({ ...d, step });
        say({ who: 'finder', text: `${f.error?.message ?? 'That did not work.'} Please send it again.` });
      }
    } catch { say({ who: 'finder', text: 'I could not reach the server. Your answers are kept; press Create again.', actions: ['confirm', 'cancel'] }); }
    setBusy(false);
  }

  async function search(q: string, wantsToStart = false) {
    lastQuery.current = q;
    try {
      const r = await fetch(`/api/v1/search?q=${encodeURIComponent(q)}&limit=3`);
      const d = await r.json();
      if (!r.ok) say({ who: 'finder', text: d.error?.message ?? 'I could not search for that.' });
      else if (d.count === 0 && wantsToStart) begin(q);
      else if (d.count === 0) say({ who: 'finder', text: `I found nothing for “${q}”. Do you want to start a fundraiser for it? You can also try other words.`, actions: ['start'] });
      else {
        const open = d.results.filter((h: Hit) => h.can_contribute).length;
        say({
          who: 'finder',
          text: `${wantsToStart ? 'Before you start a new one, these already exist. ' : ''}${d.approximate ? 'I found no exact match, but ' + (d.count === 1 ? 'this one is close' : 'these are close') + '.' : (d.count === 1 ? '1 match' : `${d.count} matches`) + '.'} ${open === 0 ? 'None is taking donations now.' : `${open} can still take your contribution.`} If none of these is what you want, you can start your own.`,
          hits: d.results, actions: ['start'],
        });
      }
    } catch { say({ who: 'finder', text: 'I could not reach the server. Try again.' }); }
  }

  function answer(raw: string, d: Draft) {
    if (d.step === 'title') {
      if (raw.length < 3 || raw.length > 120) return say({ who: 'finder', text: 'A title needs 3 to 120 characters. Try again.' });
      setDraft({ ...d, title: raw, step: 'goal' });
      return say({ who: 'finder', text: 'How much do you want to raise, in US dollars? For example: 5000, $5,000 or 2.5k.' });
    }
    if (d.step === 'goal') {
      const cents = parseGoalCents(raw);
      if (cents === null) return say({ who: 'finder', text: 'I could not read that as an amount. Use a number between $1 and $1,000,000,000, like 5000 or 2.5k.' });
      setDraft({ ...d, goal_cents: cents, step: 'story' });
      return say({ who: 'finder', text: `Goal: ${formatUsd(cents)}. Now tell people why: who is this for and what will the money do? (${STORY_MIN} to ${STORY_MAX} characters)` });
    }
    if (d.step === 'story') {
      if (raw.length < STORY_MIN) return say({ who: 'finder', text: `Add a little more, at least ${STORY_MIN} characters, so supporters know what this is for.` });
      const next: Draft = { ...d, story: raw, step: 'confirm' };
      setDraft(next);
      return say({ who: 'finder', text: `Here is what I will create:\n\nTitle: ${next.title}\nGoal: ${formatUsd(next.goal_cents)}\nStory: ${next.story}\n\nIt goes live right away and you will be the organizer.`, actions: ['confirm', 'cancel'] });
    }
    say({ who: 'finder', text: 'Press Create fundraiser to publish it, or Cancel to stop.', actions: ['confirm', 'cancel'] });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const raw = text.trim();
    if (!raw || busy) return;
    setText('');
    say({ who: 'you', text: raw });
    if (draft && /^(cancel|stop|quit|never ?mind)$/i.test(raw)) return cancel();
    if (draft) return answer(raw, draft);
    const intent = startIntent(raw);
    if (intent && !intent.topic) return begin();          // "start a fundraiser" with no topic yet
    setBusy(true);
    await search(intent ? intent.topic : raw, !!intent);
    setBusy(false);
  }

  const label: Record<Action, string> = { start: 'Start a fundraiser', confirm: 'Create fundraiser', cancel: 'Cancel' };
  function act(a: Action) {
    if (busy) return;
    if (a === 'start') return begin();
    if (a === 'cancel') return cancel();
    if (draft?.step === 'confirm') create(draft);
  }

  const lastIdx = turns.length - 1;
  const placeholder = !draft ? 'For example: wildfire'
    : draft.step === 'title' ? 'A short title' : draft.step === 'goal' ? 'For example: 5000' : draft.step === 'story' ? 'Tell people why' : 'Create or cancel';

  return (
    <section className="chat" aria-labelledby="finder-h">
      <h2 id="finder-h">Find or start a fundraiser</h2>
      <div className="chat-log" role="log" aria-live="polite" aria-label="Fundraiser finder">
        {turns.map((t, i) => (
          <div key={i} className={`chat-msg${t.who === 'you' ? ' mine' : ''}`}>
            <p>{t.text}</p>
            {t.who === 'finder' && t.hits?.map((h) => (
              <div key={h.id} className="finder-hit">
                <Link href={`/f/${h.slug}`}><strong>{h.title}</strong></Link>
                <div className="muted">{formatUsd(h.raised_cents)} of {formatUsd(h.goal_cents)} · by {h.owner_name}</div>
                {h.can_contribute
                  ? <Link className="btn primary" href={`/f/${h.slug}#donate`} style={{ width: 'auto', minHeight: 40, marginTop: 6 }}>Contribute</Link>
                  : <span className="tag no">Ended</span>}
              </div>
            ))}
            {t.who === 'finder' && t.link && <Link className="btn primary" href={t.link.href} style={{ width: 'auto', minHeight: 40, marginTop: 8 }}>{t.link.label}</Link>}
            {t.who === 'finder' && i === lastIdx && t.actions && (
              <div className="finder-actions">
                {t.actions.map((a) => (
                  <button key={a} type="button" className={`btn ${a === 'cancel' ? 'secondary' : 'primary'}`} disabled={busy} onClick={() => act(a)}>{label[a]}</button>
                ))}
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form onSubmit={submit} className="chat-form">
        <label htmlFor="finder-input" className="sr-only">{draft ? 'Your answer' : 'What do you care about?'}</label>
        <textarea id="finder-input" rows={2} maxLength={draft?.step === 'story' ? STORY_MAX : 120} value={text} placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
        <div className="chat-actions">
          <span className="muted">{text.length}/{draft?.step === 'story' ? STORY_MAX : 120}</span>
          <button className="btn primary" type="submit" disabled={busy || !text.trim()}>{draft ? 'Send' : 'Find'}</button>
        </div>
      </form>
    </section>
  );
}
