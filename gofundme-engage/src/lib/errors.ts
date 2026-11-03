import { randomUUID } from 'node:crypto';

// One error envelope for every non-2xx response:
// { error: { code, message, field?, request_id } }
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public field?: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function errorResponse(e: unknown): Response {
  const request_id = `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  if (e instanceof ApiError) {
    const error: Record<string, unknown> = { code: e.code, message: e.message, request_id };
    if (e.field) error.field = e.field;
    return json({ error }, e.status, e.headers);
  }
  console.error(request_id, e);
  return json({ error: { code: 'internal', message: 'Something went wrong', request_id } }, 500);
}

// Wrap a route handler so thrown ApiErrors become the standard envelope.
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      return errorResponse(e);
    }
  };
}
