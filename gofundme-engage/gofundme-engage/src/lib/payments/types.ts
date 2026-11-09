export interface ChargeRequest {
  donationId: string;
  amountCents: number;
  currency: 'USD';
  token: string;
}

export type ChargeStatus = 'succeeded' | 'failed' | 'pending' | 'unknown';

export interface PaymentProvider {
  createCharge(req: ChargeRequest): Promise<{ providerRef: string }>;
  // Asks the provider what happened to a charge (used when a webhook never arrived)
  getCharge(providerRef: string): Promise<ChargeStatus>;
}

export type WebhookType = 'payment.succeeded' | 'payment.failed' | 'payment.refunded';

export interface WebhookEvent {
  event_id: string;
  type: WebhookType;
  donation_id: string;
  provider_ref?: string;
}

export class ProviderUnavailableError extends Error {}
