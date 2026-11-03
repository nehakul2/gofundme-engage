import { randomUUID } from 'node:crypto';
import { sign } from './signature';
import {
  ProviderUnavailableError,
  type ChargeRequest,
  type ChargeStatus,
  type PaymentProvider,
  type WebhookEvent,
  type WebhookType,
} from './types';

// Mock payment provider. It speaks the same contract a real provider would:
// createCharge returns a reference, and the result arrives later as a signed webhook.
//
// Test tokens:
//   pm_test_ok            succeeds
//   pm_test_decline       is declined (also any unknown token)
//   pm_test_slow          succeeds after 10 s
//   pm_test_dup_webhook   succeeds, and the webhook is delivered twice
//   pm_test_down          the provider is unavailable (createCharge throws)
//   pm_test_lost_webhook  succeeds at the provider, but its webhook never arrives

export function buildWebhook(
  type: WebhookType,
  donationId: string,
  providerRef?: string,
  eventId: string = randomUUID(),
): { body: string; signature: string; event: WebhookEvent } {
  const event: WebhookEvent = { event_id: eventId, type, donation_id: donationId, provider_ref: providerRef };
  const body = JSON.stringify(event);
  return { body, signature: sign(body), event };
}

function deliverLater(delayMs: number, hook: { body: string; signature: string }) {
  const url = process.env.MOCK_PROVIDER_WEBHOOK_URL;
  if (!url) return; // auto-delivery off (tests deliver webhooks themselves)
  const t = setTimeout(() => {
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': hook.signature },
      body: hook.body,
    }).catch((e) => console.error('mock provider: webhook delivery failed', e.message));
  }, delayMs);
  t.unref?.();
}

export class MockProvider implements PaymentProvider {
  // What the "provider" knows about each charge; getCharge reads it
  readonly charges = new Map<string, ChargeStatus>();

  async getCharge(providerRef: string): Promise<ChargeStatus> {
    return this.charges.get(providerRef) ?? 'unknown';
  }

  async createCharge(req: ChargeRequest): Promise<{ providerRef: string }> {
    if (req.token === 'pm_test_down') throw new ProviderUnavailableError('mock provider is down');
    const providerRef = `mock_${req.donationId}`;
    const ok = ['pm_test_ok', 'pm_test_slow', 'pm_test_dup_webhook', 'pm_test_lost_webhook'].includes(req.token);
    this.charges.set(providerRef, ok ? 'succeeded' : 'failed');
    if (req.token === 'pm_test_lost_webhook') return { providerRef }; // no webhook is ever sent
    const base = Number(process.env.MOCK_PROVIDER_DELAY_MS ?? 500);

    if (req.token === 'pm_test_ok' || req.token === 'pm_test_slow' || req.token === 'pm_test_dup_webhook') {
      const delay = req.token === 'pm_test_slow' ? 10_000 : base;
      const hook = buildWebhook('payment.succeeded', req.donationId, providerRef);
      deliverLater(delay, hook);
      if (req.token === 'pm_test_dup_webhook') deliverLater(delay + 50, hook); // same event id, twice
    } else {
      deliverLater(base, buildWebhook('payment.failed', req.donationId, providerRef));
    }
    return { providerRef };
  }
}

let provider: PaymentProvider | undefined;
export function getPayments(): PaymentProvider {
  provider ??= new MockProvider();
  return provider;
}
export function setPayments(p: PaymentProvider | undefined) {
  provider = p;
}
