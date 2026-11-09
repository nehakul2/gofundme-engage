// Load test for one hot fundraiser: many readers refreshing, steady donations arriving.
//   k6 run -e BASE_URL=http://localhost:3000 -e SLUG=wildfire-alerts load/k6-fundraiser.js
// Afterwards run `npm run load:check` to compare the counters with the ledger.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const SLUG = __ENV.SLUG || 'wildfire-alerts';
const READERS = Number(__ENV.READERS || 200);
const DONATION_RATE = Number(__ENV.DONATION_RATE || 20); // per second
const DURATION = __ENV.DURATION || '40s';

// Unique per request without a remote import
let seq = 0;
const uuidv4 = () => `${Date.now().toString(16)}-${__VU}-${__ITER}-${seq++}-${Math.random().toString(16).slice(2, 10)}`;

const accepted = new Counter('donations_accepted');
const acceptedCents = new Counter('donations_accepted_cents');
const replays = new Counter('idempotent_replays_ok');

export const options = {
  scenarios: {
    readers: {
      executor: 'ramping-vus',
      exec: 'reader',
      startVUs: 0,
      stages: [
        { duration: '10s', target: READERS },
        { duration: DURATION, target: READERS },
        { duration: '5s', target: 0 },
      ],
    },
    donors: {
      executor: 'constant-arrival-rate',
      exec: 'donor',
      rate: DONATION_RATE,
      timeUnit: '1s',
      duration: DURATION,
      startTime: '10s',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    'http_req_duration{name:stats}': ['p(95)<150'],
    'http_req_duration{name:page}': ['p(95)<400'],
    'http_req_duration{name:donate}': ['p(95)<500'],
    'http_req_failed{name:stats}': ['rate<0.01'],
    'http_req_failed{name:donate}': ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export function reader() {
  const stats = http.get(`${BASE}/api/v1/fundraisers/${SLUG}/stats`, { tags: { name: 'stats' } });
  check(stats, { 'stats 200': (r) => r.status === 200 });
  if (Math.random() < 0.2) {
    const page = http.get(`${BASE}/f/${SLUG}`, { tags: { name: 'page' } });
    check(page, { 'page 200': (r) => r.status === 200 });
  }
  sleep(1 + Math.random());
}

export function donor() {
  const cents = 500 + Math.floor(Math.random() * 4500);
  const key = uuidv4();
  const body = JSON.stringify({ amount_cents: cents, currency: 'USD', payment_method_token: 'pm_test_ok' });
  const headers = { 'content-type': 'application/json', 'idempotency-key': key, 'x-anon-id': `load-${__VU}` };
  const res = http.post(`${BASE}/api/v1/fundraisers/${SLUG}/donations`, body, { headers, tags: { name: 'donate' } });
  const ok = check(res, { 'donation accepted (202)': (r) => r.status === 202 });
  if (!ok) return;
  accepted.add(1);
  acceptedCents.add(cents);

  // One in ten clients retries with the same key, as a flaky network would
  if (Math.random() < 0.1) {
    const again = http.post(`${BASE}/api/v1/fundraisers/${SLUG}/donations`, body, { headers, tags: { name: 'donate_retry' } });
    const same = check(again, {
      'retry replays the same donation': (r) => r.status === 202 && r.headers['Idempotent-Replay'] === 'true' && r.json('id') === res.json('id'),
    });
    if (same) replays.add(1);
  }
}
