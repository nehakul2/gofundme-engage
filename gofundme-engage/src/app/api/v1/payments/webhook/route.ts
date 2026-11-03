import { handle, json } from '@/lib/errors';
import { handleWebhook } from '@/lib/webhook';

// POST /api/v1/payments/webhook   signed by the payment provider (x-signature: sha256=<hmac>)
export const POST = handle(async (req: Request) => {
  const raw = await req.text(); // the signature covers the exact bytes received
  return json(await handleWebhook(raw, req.headers.get('x-signature')));
});
