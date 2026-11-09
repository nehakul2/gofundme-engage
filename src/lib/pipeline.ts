import { relayOnce } from './outbox';
import { LocalQueue, type Message, type Queue } from './queue';
import { applyDonationEvent, flushDirty } from './counters';
import { deliverMilestone } from './milestones';
import { deliverUpdate } from './updates';

// Routes one queue message to its consumer.
export async function handleMessage(m: Message): Promise<void> {
  const p = m.payload;
  switch (m.type) {
    case 'donation.succeeded':
      await applyDonationEvent({
        eventId: m.id,
        fundraiserId: p.fundraiser_id,
        amountCents: p.amount_cents,
        donorDelta: 1,
        pulse: { name: p.display_name ?? null, at: new Date().toISOString() },
      });
      break;
    case 'donation.refunded':
      await applyDonationEvent({
        eventId: m.id,
        fundraiserId: p.fundraiser_id,
        amountCents: -p.amount_cents,
        donorDelta: -1,
      });
      break;
    case 'milestone.reached':
      await deliverMilestone(p as Parameters<typeof deliverMilestone>[0]);
      break;
    case 'update.posted':
      await deliverUpdate(p as Parameters<typeof deliverUpdate>[0]);
      break;
    default:
      break; // donation.created has no consumer yet
  }
}

// One pass of the whole pipeline: outbox -> queue -> counters -> Postgres -> milestones.
// Milestone events come out of the flush, so the loop runs until nothing is left.
// The worker process calls this on a timer; tests call it to get a settled state.
export async function pump(queue: LocalQueue = new LocalQueue(), maxRounds = 10): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const relayed = await relayOnce(queue as Queue);
    const handled = await queue.drain(handleMessage);
    const flushed = await flushDirty();
    if (!relayed && !handled && !flushed) return;
  }
}
