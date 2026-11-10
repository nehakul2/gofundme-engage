'use client';
import { useEffect, useState } from 'react';
import ChatRoom from './ChatRoom';
import FundraiserFinder from './FundraiserFinder';

// One chat window docked at the bottom right: a "Find" tab (search assistant) and a
// "Community" tab (open lobby chat). Closed by default so it never covers the page;
// the tabs mount on first open and then stay mounted, so a conversation survives tab switches.
export default function ChatDock() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'find' | 'community'>('find');
  const [seen, setSeen] = useState({ find: false, community: false });

  useEffect(() => {
    const onOpen = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: 'find' | 'community' }>).detail?.tab ?? 'find';
      setTab(tab); setSeen((s) => ({ ...s, [tab]: true })); setOpen(true);
    };
    window.addEventListener('engage:open-chat', onOpen);
    return () => window.removeEventListener('engage:open-chat', onOpen);
  }, []);

  function show(next: 'find' | 'community') { setTab(next); setSeen((s) => ({ ...s, [next]: true })); }
  function toggle() { if (!open) setSeen((s) => ({ ...s, [tab]: true })); setOpen(!open); }

  return (
    <aside className="dock" aria-label="Chat">
      <div className="dock-panel" id="chat-dock-panel" hidden={!open}>
        <div className="dock-head">
          <div role="tablist" aria-label="Chat type" className="dock-tabs">
            <button role="tab" aria-selected={tab === 'find'} className={tab === 'find' ? 'on' : ''} onClick={() => show('find')}>Find</button>
            <button role="tab" aria-selected={tab === 'community'} className={tab === 'community' ? 'on' : ''} onClick={() => show('community')}>Community</button>
          </div>
          <button className="dock-x" onClick={() => setOpen(false)} aria-label="Close chat">×</button>
        </div>
        <div className="dock-body" role="tabpanel" hidden={tab !== 'find'}>{seen.find && <FundraiserFinder />}</div>
        <div className="dock-body" role="tabpanel" hidden={tab !== 'community'}>
          {seen.community && <ChatRoom basePath="/api/v1/lobby/chat" title="Community chat" empty="No messages yet. Ask what people are supporting." join="Choose who you are under “Viewing as” to join the conversation. Guests can read along." />}
        </div>
      </div>
      <button className="dock-launch btn primary" onClick={toggle} aria-expanded={open} aria-controls="chat-dock-panel" hidden={open}>
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
        Chat
      </button>
    </aside>
  );
}
