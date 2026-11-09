# Deploying on Railway (demo deployment)

This is a quick, low-cost demo deployment, not the AWS design in `DEPLOY.md`. It runs four things:
the web app, the worker, Postgres and Redis. Untested from the author's side: the build was checked
(`next build` passes) but nobody has deployed these files to Railway yet.

## Cost, as of Nov 2026
Railway no longer has a permanent free tier. New accounts get a one-time trial credit (reported as about $5),
and the paid Hobby plan is $5 per month including $5 of usage. Two always-on services plus two databases use
credit all month, so a trial may run out in days or weeks. Check the current terms at railway.com/pricing and
set a usage limit in Railway's billing settings before you start.

## Steps
1. Push this folder to a GitHub repository (do not commit `.env`).
2. In Railway: New Project, Deploy from GitHub repo, pick the repo. This creates the **web** service.
3. In the project: New, Database, Add PostgreSQL. Then New, Database, Add Redis.
4. Web service, Variables (use the reference syntax so the values follow the databases):
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `REDIS_URL` = `${{Redis.REDIS_URL}}`
   - `WEBHOOK_SECRET` = a long random string
   - `ADMIN_KEY` = another random string
   - `MOCK_PROVIDER_WEBHOOK_URL` = `https://<your-web-domain>/api/v1/payments/webhook` (set after step 5)
5. Web service, Settings, Networking, Generate Domain. Put that domain in `MOCK_PROVIDER_WEBHOOK_URL`.
   The config file `railway.json` builds the Dockerfile, runs `npm run migrate` before each deploy, and starts the app.
6. Add the **worker**: New, GitHub Repo (same repo). In its Settings set "Config file path" to `railway.worker.json`.
   Give it the same variables as the web service (copy `DATABASE_URL`, `REDIS_URL`, `WEBHOOK_SECRET`).
   Do not generate a public domain for it. Without the worker, donations stay pending and counters never move.
7. Load the demo data once, from your own computer. In the Postgres service copy `DATABASE_PUBLIC_URL`, then:
   ```
   DATABASE_URL="<DATABASE_PUBLIC_URL>" REDIS_URL="<Redis public url>" npm run seed
   ```
   `seed` wipes the demo tables, so run it only on a fresh database.
8. Open the generated domain. Search for "wildfire", choose a user under "Viewing as", donate with the test card.

## Before you share the link
- **Sign-in is a stand-in.** The app trusts an `x-user-id` header chosen in the browser, so anyone can act as any user.
  That is fine for a demo and unacceptable for real use. Say so in the submission.
- **Payments are a mock.** No real card is charged; the mock provider posts its own webhooks.
- Redis on Railway is not persistent by default; a restart can clear counters and chat sequence numbers. Postgres is the source of truth and the worker rebuilds the numbers.
- The live updates use long-lived connections (server-sent events). Railway allows them, but a restart drops them and the page reconnects.
