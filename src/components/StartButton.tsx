'use client';
// Starting a fundraiser happens in the chat assistant; this opens it on the Find tab.
export default function StartButton({ className = 'btn primary' }: { className?: string }) {
  return (
    <button type="button" className={className} onClick={() => window.dispatchEvent(new CustomEvent('engage:open-chat', { detail: { tab: 'find' } }))}>
      Start a fundraiser
    </button>
  );
}
