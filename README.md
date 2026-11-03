# GoFundMe Engage: backend scaffold

Donation write path, payment webhooks, live counters and milestone moments for the
Profile / Fundraiser / Community pages. The three page UIs are the next build step and
sit on top of this API.

Design source: the architecture doc and test case matrix in the "Go-Fund-Me" project.

## Run it

Needs Node 20 or newer and Docker.

```bash
npm install
docker compose up -d                          # Postgres 16 and Redis 7
cp .env.example .env
set -a; source .env; set +a                   # the scripts below read these from the environment
npm run migrate && npm run seed               # seed wipes data and loads the demo fixtures
npm run dev                                   # app and API on http://localhost:3000
```

In a second terminal (same `set -a; source .env; set +a` first), start the worker. Without it,
donations stay pending and the totals never move:

```bash
npm run worker
```

Then open http://localhost:3000, click "Wildfire alerts for everyone", and donate with the
test card. Or use curl:

```bash
curl -X POST localhost:3000/api/v1/fundraisers/wildfire-alerts/donations \
  -H 'content-type: application/json' -H 'idempotency-key: demo-key-0001' \
  -d '{"amount_cents":1500000,"currency":"USD","payment_method_token":"pm_test_ok"}'
curl localhost:3000/api/v1/fundraisers/wildfire-alerts/stats
```

Mock payment tokens: `pm_test_ok`, `pm_test_decline`, `pm_test_slow` (10 s), `pm_test_dup_webhook`, `pm_test_down`.

## Tests

```bash
docker compose exec postgres createdb -U postgres gofundme_test   # once
npm test                                                          # 167 tests, real Postgres and Redis
```

The tests use their own database (`gofundme_test`) and Redis database 1, so they do not touch your demo data.

Test names carry the matrix IDs (DON, PAY, CNT, MIL, API; SRCH, CHAT and NOTE for search, chat and notifications, added after the first matrix). Spot-check each ID against the
matrix wording; I mapped them from my notes of the matrix, not by re-reading every case.

## What is built

| Area | Where |
|---|---|
| Schema (USD only, no private communities) | `db/migrations/` |
| Idempotent donation intake | `src/lib/donations.ts` |
| Signed webhooks, guarded state transitions | `src/lib/webhook.ts`, `src/lib/payments/` |
| Transactional outbox and queue | `src/lib/outbox.ts`, `src/lib/queue.ts` |
| Redis counters, batched flush, reconcile | `src/lib/counters.ts` |
| Milestones, posts, notifications | `src/lib/milestones.ts` |
| Analytics beacon, bot filter, metrics | `src/lib/analytics.ts`, `src/lib/botfilter.ts` |
| Live pulse (SSE) | `src/lib/pulse.ts`, `src/app/api/v1/fundraisers/[ref]/pulse/` |
| Fundraiser create and edit (If-Match, 428/412) | `src/lib/fundraisers.ts` |
| Pending-payment verification (24 h query, 48 h close) | `src/lib/verify.ts` |
| Fundraiser search (with can-contribute verdict) | `src/lib/search.ts`, `src/app/search/`, `src/app/api/v1/search/` |
| Chat room per fundraiser | `src/lib/chat.ts`, `src/components/ChatRoom.tsx`, `src/app/api/v1/fundraisers/[ref]/chat/` |
| Notifications and the header bell | `src/lib/notifications.ts`, `src/components/Bell.tsx`, `src/app/api/v1/me/notifications/` |
| Routes | `src/app/api/v1/` |

## Not built yet

Joining communities and posting; chat moderation beyond author and organizer removal (no reporting, no blocking, no word filter, no per-room mute); direct messages; create/edit screens for fundraisers (the API exists); server-side
visit snapshots for signed-in users (the banner uses browser storage only); an admin dashboard page for the metrics; applying the AWS config (see `docs/DEPLOY.md`);
SQS FIFO in place of the in-process queue; email notifications; the 24 h notification cap.

## Differences from the architecture doc

- `donations.donor_name` added for guest names.
- The `ms:{fundraiser}:{pct}` Redis pre-check flag is dropped; the milestone primary key is the only guard (a lost flag could have skipped a milestone).
- A milestone outbox event carries a `thresholds` array, one event per flush.
- `donor_count` is the number of succeeded donations.
- Route param is `[ref]` (slug or UUID), because Next.js cannot have sibling `[slug]` and `[id]`.
- Auth is a dev stub (`x-user-id` header).
- `LocalQueue` runs inside the worker instead of SQS FIFO; same ordering rule (one lane per fundraiser).
- `flush:dirty` is a single key, so it is not Redis Cluster safe yet.
- A provider failure stores a 502 under the idempotency key, so a retry needs a new key.

## Pages

| Route | What it shows |
|---|---|
| `/` | Fundraisers and communities |
| `/search?q=` | Search results; each says whether you can still contribute |
| `/notifications` | The viewer's inbox (milestones); opening it marks everything read |
| `/f/[slug]` | Fundraiser: live progress (polls every 4 s), donate form, follow, share, recent supporters, supporter chat, "since you last visited" banner |
| `/u/[handle]` | Profile: fundraisers, communities, follow |
| `/c/[slug]` | Community: fundraisers, updates feed (milestone posts included), members, follow |

The "Viewing as" menu in the header stands in for sign-in (sends `x-user-id`). Guests get an
`x-anon-id` kept in the browser. Set `NEXT_PUBLIC_BANNER_MIN_MINUTES=0` to see the banner
without waiting an hour. A removed fundraiser renders a "removed" page with status 200 (the API returns 410).

## Look and feel

The pages follow the "GoFundMe Pages Designs" canvas: navy ink, teal for progress and actions, amber for milestones, Bricolage Grotesque and Manrope (loaded from Google Fonts; a system font shows if offline). The fundraiser page is one card with the total, the progress bar (ticks at 25, 50 and 75%, "Next: N%"), the amount buttons ($25, $50, $100, $250), Donate, Share and Follow, with a "Live now" card under it. On a phone the donate card moves above the story. The header has the search box, a bell with the unread count (signed-in viewers) and the "Viewing as" menu. Updates on a fundraiser come from the milestones it has reached. Not in the app: photos (the schema has `cover_image_url`, shown only when set; nothing sets it yet) and a "since you last visited" banner on community pages.

Notifications: `GET /api/v1/me/notifications/unread-count`, `GET /api/v1/me/notifications`, `POST /api/v1/me/notifications/read` with `{ all: true }` or `{ ids }`. The count comes from Postgres; reading the inbox also resets the Redis counter.

## Homepage chat window

A **Chat** button sits at the bottom right of the home page and opens one small window with two tabs, so nothing covers the page until you ask for it. **Find** is a question box over the search API: type a cause, get up to three matches with a Contribute button, or "Ended" when donations are closed. Every answer offers **Start a fundraiser**: the chat asks for a title, a goal ("5000", "$5,000", "2.5k") and a story, shows a summary, and on Create calls `POST /api/v1/fundraisers`; the fundraiser is live at once and the viewer is its organizer. Guests are asked to choose who they are first. Each user can start 5 per hour (429 after that). There is no review step before a new fundraiser goes live, and no check for near-duplicate titles beyond the search shown first. **Community** is one open lobby room for everyone; guests read, signed-in users post. It runs on the same chat code as fundraiser rooms (`LOBBY_REF`, routes under `/api/v1/lobby/chat`), with the same limits (500 characters, 5 messages per 10 seconds). The lobby has no organizer, so only a message's author can remove it. Migration `005_lobby_chat.sql` drops the foreign key from chat messages to fundraisers so the lobby can have a fixed room id; fundraiser rooms are still checked in code. Tests: LOBBY-01 to LOBBY-06 and MAKE-01 to MAKE-07. On a phone the window fills the width at the bottom.

## Rename or end a fundraiser

The organizer sees a **Manage your fundraiser** card at the bottom of the fundraiser page; nobody else sees it. **Save name** renames the fundraiser (3 to 120 characters); the web address does not change, so shared links keep working. **End fundraiser** asks for confirmation, then stops donations and chat for good; the page, chat history and donor list stay readable and search shows "Ended". An ended fundraiser cannot be reopened, but it can still be renamed. Both use `PATCH /api/v1/fundraisers/:ref` with `If-Match`: 403 for anyone but the owner, 401 for guests, 412 if another edit got there first. Tests: EDIT-01 to EDIT-05, END-01 to END-05. Not built: editing the story or goal in the UI (the API supports it), and changing the address when the name changes.

Continuous integration runs on every push (`.github/workflows/ci.yml`: type check, tests against real Postgres and Redis, production build). Deploying a demo on Railway, with deploy-on-commit: see `docs/RAILWAY.md` (config files `railway.json` and `railway.worker.json`). The AWS design is in `docs/DEPLOY.md`.

## Admin page and chat moderation

**Admin page** at `/admin`: engagement numbers for the last 1, 7, 30 or 90 days (visitors, repeat visitors, share who donated, shared or followed, split by repeat and new visitors, action counts, bot traffic left out), the chat report queue, and the blocked-word list. It reads `GET /api/v1/metrics/engagement`, `GET /api/v1/admin/reports` and `/api/v1/admin/words`. When the server has `ADMIN_KEY` set (it should be, on Railway) you type the key once per browser tab; it is sent as `x-admin-key`. With no `ADMIN_KEY` (local development) the page is open.

**Chat moderation** (beyond removal by the author or organizer), in fundraiser rooms and the homepage lobby:

- **Report**: signed-in users can report someone else's message (`POST /api/v1/chat/messages/:id/report`, optional reason up to 200 characters). Reporting twice changes nothing; you cannot report your own message. Reports collect in the admin queue, grouped by message with the most reported first, and an admin chooses **Remove message** (hidden for everyone, live in open chats) or **Dismiss**.
- **Mute**: a person can mute someone (`POST` and `DELETE /api/v1/me/mutes`). Their messages disappear for the muter only, and a "Muted: ... Unmute" line shows who is muted. It does not affect anyone else's view.
- **Word filter**: admins block words; a message containing one as a whole word, in any capitalisation, is refused with 422 `message_blocked` (so blocking "ass" does not block "class"). The same list also applies to fundraiser titles and stories (on create and edit) and to community names and descriptions, refused with 422 `text_blocked`, and the message names the blocked word. The chat checks the title and story as they are typed (`GET /api/v1/words/check?text=`), so the person is told right away. It does not look at donor names or donation comments. The list starts empty.

Migration `007_moderation.sql` adds `chat_reports`, `user_mutes` and `blocked_words`. Tests: MOD-01 to MOD-13. Not built: automatic hiding after several reports, appeals, banning someone from posting, direct messages, notifying the person whose message was removed, and an admin login (the shared `ADMIN_KEY` is the only protection). Search still uses plain text matching plus trigram similarity; full-text search is the step for a large catalogue.

## Starting and joining communities

Anyone signed in can start a community from the home page (**Start a community**: name 3 to 60 characters, optional description up to 280) or from the chat ("start a community for Foster City parents"). The chat first looks for existing communities with those words and points to them; if none fit it asks for a name and a description, shows a summary and creates it. The creator becomes the **owner** and first member, and the address comes from the name (`/c/foster-city-parents`; a taken name gets a short suffix). Each person can start 3 per hour (429 after that).

On a community page the viewer sees a card: **Join this community** or **Leave** (the owner cannot leave, 422), and for members **Add one of your fundraisers**, which lists a fundraiser the member owns in the community (only your own, never removed ones, safe to repeat).

- `POST /api/v1/communities` `{ name, description? }` returns 201 with the community
- `GET /api/v1/communities?q=` returns up to 5 matches (every word must appear in the name or description)
- `POST` and `DELETE /api/v1/communities/:slug/members` join and leave
- `POST /api/v1/communities/:slug/fundraisers` `{ fundraiser: "<slug>" }`
- `GET /api/v1/communities/:slug/me` the viewer's role and which of their fundraisers can still be added

Tests: COMM-01 to COMM-14. Not built: renaming or deleting a community, removing members, moderator tools, private communities (the schema rules them out).

## Nearby fundraisers and recent events (US only)

In the homepage chat, type a US zip code (`94404`) or `City, ST` (`Foster City, CA`). The chat shows fundraisers already near that place, what happened there in the last 6 months, and ideas for starting one. Picking an idea starts the guided create with the title filled in and the location attached.

- API: `GET /api/v1/places/suggest?q=94404` returns `place`, `nearby`, `incidents`, `incident_sources` and `ideas`. Errors: `not_a_place` 400, `zip_not_found` and `city_not_found` 404, `ambiguous_city` and `unsupported_country` 422.
- Places are looked up offline: zip codes from the `zipcodes` package, towns from `src/data/us-places.json` (built by `scripts/build-places.mjs`). A zip is named after the closest town, so 94404 reads "Foster City", not the post office's "San Mateo".
- A fundraiser can be created with an optional `zip`; it stores city, state and coordinates (migration 008). "Nearby" means within 25 miles. Fundraisers without a location match when the town name is in the title or story.
- Recent events come from two free public sources with no key: FEMA federal disaster declarations for the county (floods, fires, storms) and USGS earthquakes of magnitude 4 or more within 60 km. Results are cached for 6 hours. Each call has a 4.5 s timeout, and if one fails the answer still comes back and names the source that failed.
- Limits: this does not cover local crime, school closures or news, since there is no free structured source for them. Only US places are supported.
- Attribution: place names and coordinates come from GeoNames (https://www.geonames.org), licensed CC BY 4.0, through the `all-the-cities` package.

## Search: plain questions and typos

Search also handles a question such as "do we have a fundraiser for foster city school district reading program". It tries three passes: every word as typed; then without filler ("do we have a fundraiser for"); then close spellings, using Postgres `pg_trgm` (migration `006_trgm.sql`), so "progrm" finds "program". A result set from the third pass has `approximate: true` and the chat says "no exact match, but this one is close". A message like "start a fundraiser for X" is treated as a request to create one: the chat shows existing matches for X first, or goes straight to the title step with X filled in. Tests: SRCH-12 to SRCH-16, MAKE-08, MAKE-09. Limit: the spelling pass compares titles and organizer names only, and scans all public fundraisers, so it would need a trigram index at larger scale.

## Search

The search box in the header (and `/search?q=`) finds public fundraisers, meaning active or ended; drafts and removed fundraisers never appear. Every word must match the title, story, organizer name or link name, case-insensitively, and `%` and `_` are searched as plain characters. Title matches rank first, then active before ended. Each result carries `can_contribute` (true only for an active fundraiser, the same rule the donation API enforces) and, when false, a reason. `GET /api/v1/search?q=...&limit=20` returns the same data (2 to 100 characters; limit 1 to 50; cached 5 s). Matching uses `ILIKE`, fine for the demo data; at real scale this moves to Postgres full-text search with a trigram index or a search service.

## Supporter chat

Each active fundraiser page has a chat room. Anyone can read; only a signed-in user (the "Viewing as" stand-in) can post. Messages are plain text, 1 to 500 characters, with control characters stripped; the page never renders HTML. A user can send 5 messages per 10 seconds (429 with `Retry-After`). The author or the fundraiser's organizer can remove a message (soft delete: kept in the table for audit, never returned again). Chat is read-only on an ended fundraiser and gone on a removed one. A retried send with the same `client_id` returns the first message instead of posting twice.

- `GET /api/v1/fundraisers/:ref/chat?before=<id>|after=<id>&limit=50` (newest page, oldest first, `has_more`)
- `POST /api/v1/fundraisers/:ref/chat` `{ body, client_id? }` returns 201, or 200 with `idempotent-replay: true`
- `DELETE /api/v1/fundraisers/:ref/chat/:messageId` returns 204
- `GET /api/v1/fundraisers/:ref/chat/stream` (SSE `message` and `removed` events). Each post or delete bumps a Redis counter; the stream checks the counter once a second and queries Postgres only when it moved (plus a 15 s safety check). On every connect the page fetches what it missed. Like the pulse, this is per-connection polling; at scale it moves to Redis pub/sub.

Chat messages are not counted as a "meaningful action" in the engagement metrics; the PRD names donate, share and follow.

## Measuring repeat visits and meaningful actions

- The browser sends one page-view beacon per route change (`POST /api/v1/events`).
- The server records meaningful actions itself: `donate` (when the payment settles, not when it is attempted), `share` (counted shares only) and `follow` (new follows only).
- `GET /api/v1/metrics/engagement?days=7` returns visitors, repeat visitors (seen on 2 or more UTC days in the window), the share of visitors who acted, and the action rate split by repeat vs new visitors, plus how many events were excluded and why.
- A visitor is the signed-in user id, or the anonymous browser id. Someone who signs in mid-window counts as two visitors.
- Bot and internal traffic is stored with a reason and excluded from every number. Three layers: network ranges (`INTERNAL_CIDRS`), deterministic markers (`INTERNAL_TRAFFIC_KEY` header `x-internal-traffic`, visitor ids starting `synthetic_`, the `GoFundMe-Synthetic` agent), and behavior (crawler user agents, more than 30 events a minute).
- Set `ADMIN_KEY` to require an `x-admin-key` header on the metrics endpoint.

## Live pulse

`/f/[slug]` opens an event stream (`GET /api/v1/fundraisers/:ref/pulse`). Each settled donation appears as "Name just donated $X" (anonymous donors show as "Someone"). More than 5 new donations in one second collapse into one summary line. Share and follow events never appear. The stream polls Redis once a second per connection; at real scale this moves to Redis pub/sub or a fan-out service.

## Fundraiser create and edit

`POST /api/v1/fundraisers` returns the created object (201) with its ETag, so clients never read it back. `PATCH /api/v1/fundraisers/:ref` needs `If-Match: "v<version>"`: no header gives 428, a stale version gives 412 with the current ETag, and the version check is part of the update so two simultaneous edits cannot both succeed. Only the owner can edit; the goal cannot go below what is raised; status only moves draft to active to ended.

## Pending payments that never settle

The worker asks the payment provider about any donation still pending after 24 h and applies the answer through the same code a webhook uses. A donation still unresolved after 48 h is closed as failed. A pending donation is never counted. If the provider is down, the donation stays pending and is retried on the next run (every 10 minutes).

## Load test

`load/k6-fundraiser.js` hammers one fundraiser with readers and steady donations (a tenth of them retried with the same key). `npm run load:check` then compares the ledger, the Postgres stats and the Redis counter.

Local run, one 2-core sandbox running the app, worker, Postgres, Redis and k6 together, mock payment provider (these are smoke-test numbers, not capacity numbers):

| | 100 readers, 15 donations/s | 200 readers, 60 donations/s |
|---|---|---|
| Requests, failures | 4,499, 0 | 8,096, 0 |
| p95 stats read | 7 ms | 13 ms |
| p95 donation write | 16 ms | 35 ms |
| Ledger = Postgres = Redis | yes (601 donations) | yes (2,402 donations after both runs) |
| Duplicate idempotency keys | 0 | 0 |

In the second run the fundraiser crossed 25, 50, 75 and 100% under concurrent load: each milestone fired once, with one post and one notification each.

## Migrations on Railway

`npm run start` now runs `npm run migrate` first (it only applies files not yet recorded in `schema_migrations`), then starts the server, so a deploy cannot be left without its tables. If migrate fails, the log shows `WARNING: migrate failed, starting anyway` and the app still starts. The `preDeployCommand` in `railway.json` stays as a second chance. The worker has its own start command and does not migrate.

## Local services without Docker

`./scripts/dev-services.sh` starts Postgres and Redis directly (used in the sandbox where I built this).
