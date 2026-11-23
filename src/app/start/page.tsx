import type { Metadata } from 'next';
import StartFundraiser from '@/components/StartFundraiser';

export const metadata: Metadata = { title: 'Start a fundraiser | Engage' };

export default function StartPage() {
  return (
    <div className="startpage">
      <h1>Start a fundraiser</h1>
      <p className="muted">Tell people what you are raising money for. You can add a photo now or later, and post updates once you are live.</p>
      <StartFundraiser />
    </div>
  );
}
