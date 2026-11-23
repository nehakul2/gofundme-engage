import Link from 'next/link';

// Opens the start-a-fundraiser form.
export default function StartButton({ className = 'btn primary' }: { className?: string }) {
  return <Link href="/start" className={className}>Start a fundraiser</Link>;
}
